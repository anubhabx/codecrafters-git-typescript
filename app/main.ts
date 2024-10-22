import * as fs from "fs";
import * as zlib from "zlib";

const args = process.argv.slice(2);
const command = args[0];

enum Commands {
  Init = "init",
  CatFile = "cat-file",
}

switch (command) {
  case Commands.Init:
    fs.mkdirSync(".git", { recursive: true });
    fs.mkdirSync(".git/objects", { recursive: true });
    fs.mkdirSync(".git/refs", { recursive: true });
    fs.writeFileSync(".git/HEAD", "ref: refs/heads/main\n");
    console.log("Initialized git directory");
    break;
  case Commands.CatFile:
    const hash = args[2];
    // console.log(`Hash: ${hash}`);

    const file = `.git/objects/${hash.slice(0, 2)}/${hash.slice(2)}`;
    const buffer = fs.readFileSync(file);
    zlib.inflate(buffer, (err, inflated) => {
      if (err) {
        console.error(err);
        return;
      }

      const [header, content] = inflated.toString().split("\0");
      process.stdout.write(content.trim());
    });
    break;
  default:
    throw new Error(`Unknown command ${command}`);
}
