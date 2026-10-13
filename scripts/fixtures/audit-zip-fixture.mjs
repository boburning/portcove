import { crc32, deflateRawSync } from "node:zlib";

export function createAuditZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, raw, options = {}] of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(raw);
    const method = options.method ?? 8;
    const compressed = method === 0 ? data : deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const record = Buffer.concat([header, filename, compressed]);
    local.push(record);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50);
    dir.writeUInt16LE(0x314, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc32(data), 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(filename.length, 28);
    dir.writeUInt32LE(options.attributes ?? 0x81a40000, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, filename]));
    offset += record.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
