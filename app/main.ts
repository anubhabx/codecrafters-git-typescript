import * as fs from "fs";
import * as zlib from "zlib";
import * as crypto from "crypto";

const args = process.argv.slice(2);
const command = args[0];

enum Commands {
  Init = "init",
  CatFile = "cat-file",
  HashObject = "hash-object",
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
    const hashArg = args[2];
    // console.log(`Hash: ${hash}`);

    const file = `.git/objects/${hashArg.slice(0, 2)}/${hashArg.slice(2)}`;
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

  case Commands.HashObject:
    const content = fs.readFileSync(args[2], "utf-8");
    const header = `blob ${content.length}\0`;
    const store = header + content;

    const hash = crypto.createHash("sha1").update(store).digest("hex");
    const dir = `.git/objects/${hash.slice(0, 2)}`;
    const fileName = `${dir}/${hash.slice(2)}`;

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    zlib.deflate(store, (err, deflated) => {
      if (err) {
        console.error(err);
        return;
      }

      fs.writeFileSync(fileName, deflated);
      process.stdout.write(hash);
    });

    break;

  default:
    throw new Error(`Unknown command ${command}`);
}
