// Trusted parser subprocess; never evaluates uploaded scripts or markup.
const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 15 * 1024 * 1024) process.exit(1);
  chunks.push(chunk);
}
const buffer = Buffer.concat(chunks),
  extension = process.argv[2];
let text;
if (extension === 'pdf') {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    text = (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
} else if (extension === 'docx') {
  const mammoth = await import('mammoth');
  text = (await mammoth.extractRawText({ buffer })).value;
} else {
  text = buffer.toString('utf8');
  if (['html', 'htm'].includes(extension))
    text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ');
}
if (Buffer.byteLength(text) > 2_000_000) process.exit(1);
process.stdout.write(text);
