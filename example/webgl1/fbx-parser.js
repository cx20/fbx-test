// fbx-parser.js — minimal binary + ASCII FBX parser used by the WebGL samples.
//
// Exposes a global `FBXParser` namespace with:
//   parseFBX(buffer): Promise<{ version, nodes }>
//   findNode(nodes, name): node | null
//   findNodes(nodes, name): node[]
//   prop0(node): first property or null
//
// Each parsed node is { name, props, children }.
//
// This is a trimmed copy of the parser embedded in
// example/babylonjs/fbx-loader.js.

(function (root) {

const FBX_TIME_UNIT_SECONDS = 1 / 46186158000;

class FBXReader {
    constructor(buffer) {
        this.dv = new DataView(buffer);
        this.offset = 0;
    }
    getUint8()   { return this.dv.getUint8(this.offset++); }
    getInt16()   { const v = this.dv.getInt16(this.offset, true);  this.offset += 2; return v; }
    getInt32()   { const v = this.dv.getInt32(this.offset, true);  this.offset += 4; return v; }
    getUint32()  { const v = this.dv.getUint32(this.offset, true); this.offset += 4; return v; }
    getFloat32() { const v = this.dv.getFloat32(this.offset, true);this.offset += 4; return v; }
    getFloat64() { const v = this.dv.getFloat64(this.offset, true);this.offset += 8; return v; }
    getInt64()   {
        const lo = this.getUint32(), hi = this.getUint32();
        return hi * 4294967296 + lo;
    }
    getString(len) {
        const s = new TextDecoder().decode(new Uint8Array(this.dv.buffer, this.offset, len));
        this.offset += len;
        return s;
    }
    getArrayBuffer(len) {
        const buf = this.dv.buffer.slice(this.offset, this.offset + len);
        this.offset += len;
        return buf;
    }
    skip(n)       { this.offset += n; }
    skipTo(pos)   { this.offset = pos; }
    get pos()     { return this.offset; }
}

async function zlibDecompress(arrayBuffer) {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(arrayBuffer));
    writer.close();
    const chunks = [];
    const reader = ds.readable.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out.buffer;
}

function decodeInt64Array(raw, count) {
    const dv = new DataView(raw);
    const values = [];
    for (let i = 0; i < count; i++) {
        const off = i * 8;
        const lo = dv.getUint32(off, true);
        const hi = dv.getInt32(off + 4, true);
        values.push(hi * 4294967296 + lo);
    }
    return values;
}

async function parseProp(reader) {
    const type = reader.getString(1);
    switch (type) {
        case 'C': return reader.getUint8() !== 0;
        case 'Y': return reader.getInt16();
        case 'I': return reader.getInt32();
        case 'F': return reader.getFloat32();
        case 'D': return reader.getFloat64();
        case 'L': return reader.getInt64();
        case 'S': { const n = reader.getUint32(); return reader.getString(n); }
        case 'R': { const n = reader.getUint32(); return reader.getArrayBuffer(n); }
        case 'f': case 'd': case 'i': case 'l': case 'b': case 'c': {
            const count = reader.getUint32();
            const enc   = reader.getUint32();
            const clen  = reader.getUint32();
            let raw = reader.getArrayBuffer(clen);
            if (enc === 1) raw = await zlibDecompress(raw);
            if (type === 'l') return decodeInt64Array(raw, count);
            const Ctor = { f: Float32Array, d: Float64Array, i: Int32Array,
                           b: Uint8Array,   c: Uint8Array }[type];
            return Array.from(new Ctor(raw));
        }
        default: throw new Error(`Unknown FBX property type: ${type}`);
    }
}

async function parseNodes(reader, endOffset, is64bit) {
    const nullSize = is64bit ? 25 : 13;
    const nodes = [];
    while (reader.pos < endOffset) {
        const nodeEnd  = is64bit ? reader.getInt64() : reader.getUint32();
        const numProps = is64bit ? reader.getInt64() : reader.getUint32();
        is64bit ? reader.getInt64() : reader.getUint32(); // propListLen
        const nameLen  = reader.getUint8();
        const name     = reader.getString(nameLen);
        if (nodeEnd === 0) break;

        const props = [];
        for (let i = 0; i < numProps; i++) props.push(await parseProp(reader));

        const children = [];
        if (reader.pos < nodeEnd - nullSize) {
            const sub = await parseNodes(reader, nodeEnd - nullSize, is64bit);
            children.push(...sub);
        }
        reader.skipTo(nodeEnd);
        nodes.push({ name, props, children });
    }
    return nodes;
}

// ASCII FBX parser → same { name, props, children } tree.
//
// Grammar (simplified): each non-empty, non-comment line is
//   <Name>: [<prop>, <prop>, ...]  [{
//      <child nodes...>
//   }]
// Array properties (huge vertex/index lists) are written as
//   *<count> {
//      a: <comma-separated numbers, possibly on many lines>
//   }
// and are returned as a single `number[]` property to match the binary
// parser's behavior.
function parseAsciiNodes(text) {
    const lines = text.split(/\r?\n/);
    let pos = 0;

    function nextContentLine() {
        while (pos < lines.length) {
            const line = lines[pos++].trim();
            if (line && !line.startsWith(';')) return line;
        }
        return null;
    }

    function parseScalarProps(str) {
        const props = [];
        let i = 0;
        while (i < str.length) {
            while (i < str.length && (str[i] === ',' || str[i] === ' ' || str[i] === '\t')) i++;
            if (i >= str.length) break;
            if (str[i] === '"') {
                let j = i + 1;
                while (j < str.length && str[j] !== '"') j++;
                props.push(str.slice(i + 1, j));
                i = j + 1;
            } else {
                let j = i;
                while (j < str.length && str[j] !== ',' && str[j] !== ' ' && str[j] !== '\t') j++;
                const token = str.slice(i, j).trim();
                if (token.length) {
                    const num = Number(token);
                    props.push(Number.isNaN(num) ? token : num);
                }
                i = j;
            }
        }
        return props;
    }

    function readArrayValues() {
        const values = [];
        while (pos < lines.length) {
            const line = lines[pos++].trim();
            if (!line || line.startsWith(';')) continue;
            if (line === '}') break;
            const start = line.startsWith('a:') ? 2 : 0;
            for (const token of line.slice(start).split(',')) {
                const t = token.trim();
                if (t) values.push(Number(t));
            }
        }
        return values;
    }

    function parseNode(line) {
        const colonIdx = line.indexOf(':');
        if (colonIdx < 0) return null;
        const name = line.slice(0, colonIdx).trim();
        let rest = line.slice(colonIdx + 1).trim();

        const hasBlock = rest.endsWith('{');
        if (hasBlock) rest = rest.slice(0, -1).trim();

        const props = [];
        const children = [];

        if (rest.startsWith('*')) {
            if (hasBlock) props.push(readArrayValues());
        } else {
            if (rest.length > 0) props.push(...parseScalarProps(rest));
            if (hasBlock) {
                while (true) {
                    const child = nextContentLine();
                    if (!child || child === '}') break;
                    const node = parseNode(child);
                    if (node) children.push(node);
                }
            }
        }

        return { name, props, children };
    }

    const nodes = [];
    while (true) {
        const line = nextContentLine();
        if (!line) break;
        if (line === '}') continue;
        const node = parseNode(line);
        if (node) nodes.push(node);
    }
    return nodes;
}

async function parseFBX(buffer) {
    const peek = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buffer, 0, 23));
    if (!peek.startsWith('Kaydara FBX Binary')) {
        const text = new TextDecoder().decode(buffer);
        const nodes = parseAsciiNodes(text);
        const headerExt = nodes.find(n => n.name === 'FBXHeaderExtension');
        const versionNode = headerExt?.children.find(n => n.name === 'FBXVersion');
        const version = typeof versionNode?.props[0] === 'number' ? versionNode.props[0] : 7500;
        return { version, nodes };
    }
    const reader = new FBXReader(buffer);
    reader.skip(23); // magic header (21 bytes + 0x1A 0x00)
    const version = reader.getUint32();
    if (version < 7000) throw new Error(`FBX version ${version} not supported (need >= 7000)`);
    const is64bit = version >= 7500;
    const nodes = await parseNodes(reader, buffer.byteLength, is64bit);
    return { version, nodes };
}

function findNode(nodes, name) {
    return nodes.find(n => n.name === name) ?? null;
}
function findNodes(nodes, name) {
    return nodes.filter(n => n.name === name);
}
function prop0(node) { return node?.props[0] ?? null; }

root.FBXParser = {
    parseFBX,
    findNode,
    findNodes,
    prop0,
    FBX_TIME_UNIT_SECONDS,
};

})(window);
