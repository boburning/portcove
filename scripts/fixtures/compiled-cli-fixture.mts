/** Inert archive-constructor fixture only. These bytes are never executable. */
export function compiledCliTarFixture(content: Buffer) {
  const header = Buffer.alloc(512);
  header.write("portcove");
  header.write("0000755\0", 100, "ascii");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0" + "00", 257, "ascii");
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return Buffer.concat([
    header,
    content,
    Buffer.alloc(((512 - (content.length % 512)) % 512) + 1024),
  ]);
}
