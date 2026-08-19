import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const assetsDirectory = join(desktopDirectory, "assets");
const sourcePath = join(assetsDirectory, "devloop-app-icon.png");
const outputPath = join(assetsDirectory, "devloop-app-icon.icns");

const iconChunks = [
  { type: "icp4", size: 16 },
  { type: "icp5", size: 32 },
  { type: "icp6", size: 64 },
  { type: "ic07", size: 128 },
  { type: "ic08", size: 256 },
  { type: "ic09", size: 512 },
  { type: "ic10", size: 1024 },
];

const workingDirectory = await mkdtemp(join(tmpdir(), "devloop-icon-"));

try {
  const chunks = await Promise.all(
    iconChunks.map(async ({ type, size }) => {
      const imagePath = join(workingDirectory, `${type}.png`);
      await execFileAsync("sips", ["-z", String(size), String(size), sourcePath, "--out", imagePath]);
      return { type, image: await readFile(imagePath) };
    }),
  );

  const totalLength = 8 + chunks.reduce((total, chunk) => total + 8 + chunk.image.length, 0);
  const output = Buffer.alloc(totalLength);
  output.write("icns", 0, "ascii");
  output.writeUInt32BE(totalLength, 4);

  let offset = 8;
  for (const chunk of chunks) {
    output.write(chunk.type, offset, "ascii");
    output.writeUInt32BE(chunk.image.length + 8, offset + 4);
    chunk.image.copy(output, offset + 8);
    offset += chunk.image.length + 8;
  }

  await writeFile(outputPath, output);
  process.stdout.write(`Generated ${outputPath}\n`);
} finally {
  await rm(workingDirectory, { recursive: true, force: true });
}
