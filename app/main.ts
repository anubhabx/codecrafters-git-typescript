import * as fs from "fs";
import * as zlib from "zlib";
import path from "path";
import crypto from "crypto";
import { promisify } from "util";

const inflate = promisify(zlib.inflate);
const deflate = promisify(zlib.deflate);

enum Commands {
  Init = "init",
  CatFile = "cat-file",
  HashObject = "hash-object",
  LSTree = "ls-tree",
}

interface TreeEntry {
  mode: string;
  type: string;
  hash: string;
  name: string;
}

interface GitObject {
  type: string;
  content: Buffer;
}

interface LsTreeOptions {
  recursive: boolean;
  nameOnly: boolean;
}

class GitCommand {
  private static GIT_DIR = ".git";

  private static async readGitObject(hash: string): Promise<Buffer> {
    const objectPath = path.join(
      GitCommand.GIT_DIR,
      "objects",
      hash.slice(0, 2),
      hash.slice(2)
    );
    return fs.promises.readFile(objectPath);
  }

  private static async inflateObject(buffer: Buffer): Promise<GitObject> {
    const inflated = await inflate(buffer);

    const nullByteIndex = inflated.indexOf(0);
    if (nullByteIndex === -1) {
      throw new Error("Invalid git object format: no null byte found");
    }

    const header = inflated.slice(0, nullByteIndex).toString("utf-8");
    const [type, size] = header.split(" ");

    const content = inflated.slice(nullByteIndex + 1);
    const contentSize = parseInt(size);
    if (content.length !== contentSize) {
      throw new Error(
        `Content size mismatch. Expected ${contentSize}, got ${content.length}`
      );
    }

    return { type, content };
  }

  private static async writeGitObject(
    type: string,
    content: Buffer
  ): Promise<string> {
    const header = Buffer.from(`${type} ${content.length}\0`);
    const store = Buffer.concat([header, content]);

    const hash = crypto.createHash("sha1").update(store).digest("hex");
    const dir = path.join(GitCommand.GIT_DIR, "objects", hash.slice(0, 2));
    const fileName = path.join(dir, hash.slice(2));

    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    const deflated = await deflate(store);
    await fs.promises.writeFile(fileName, deflated);

    return hash;
  }

  private static parseTreeContent(buffer: Buffer): TreeEntry[] {
    const entries: TreeEntry[] = [];
    let position = 0;

    while (position < buffer.length) {
      // Find the space that separates mode from type+path
      let spaceIndex = buffer.indexOf(0x20, position);
      if (spaceIndex === -1) break;

      const mode = buffer.slice(position, spaceIndex).toString("utf-8");

      // Find the null byte that separates path from hash
      let nullIndex = buffer.indexOf(0x00, spaceIndex + 1);
      if (nullIndex === -1) break;

      const entryInfo = buffer
        .subarray(spaceIndex + 1, nullIndex)
        .toString("utf-8");
      const lastSpaceIndex = entryInfo.lastIndexOf(" ");
      const name = entryInfo.slice(lastSpaceIndex + 1);
      const type = entryInfo.slice(0, lastSpaceIndex);

      // Extract the 20-byte SHA-1 hash
      const hashBuffer = buffer.subarray(nullIndex + 1, nullIndex + 21);
      const hash = hashBuffer.toString("hex");

      entries.push({ mode, type, hash, name });

      // Move position to start of next entry
      position = nullIndex + 21;
    }

    return entries;
  }

  static async init(): Promise<void> {
    await fs.promises.mkdir(GitCommand.GIT_DIR, { recursive: true });
    await fs.promises.mkdir(path.join(GitCommand.GIT_DIR, "objects"), {
      recursive: true,
    });
    await fs.promises.mkdir(path.join(GitCommand.GIT_DIR, "refs"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(GitCommand.GIT_DIR, "HEAD"),
      "ref: refs/heads/main\n"
    );
    console.log("Initialized git directory");
  }

  static async catFile(hash: string): Promise<void> {
    try {
      const buffer = await GitCommand.readGitObject(hash);
      const { content } = await GitCommand.inflateObject(buffer);
      process.stdout.write(content);
    } catch (error) {
      console.error("Error reading object:", error);
      process.exit(1);
    }
  }

  static async hashObject(filePath: string): Promise<void> {
    try {
      const content = await fs.promises.readFile(filePath);
      const hash = await GitCommand.writeGitObject("blob", content);
      process.stdout.write(hash);
    } catch (error) {
      console.error("Error hashing object:", error);
      process.exit(1);
    }
  }

  static async lsTree(treeHash: string, options: LsTreeOptions): Promise<void> {
    try {
      const buffer = await GitCommand.readGitObject(treeHash);
      const { content } = await GitCommand.inflateObject(buffer);
      const entries = GitCommand.parseTreeContent(content);

      for (const entry of entries) {
        if (options.nameOnly) {
          console.log(entry.name);
        } else {
          console.log(
            `${entry.mode} ${entry.type} ${entry.hash}\t${entry.name}`
          );
        }

        if (options.recursive && entry.type === "tree") {
          await GitCommand.lsTree(entry.hash, options);
        }
      }
    } catch (error) {
      console.error("Error listing tree:", error);
      process.exit(1);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case Commands.Init:
        await GitCommand.init();
        break;

      case Commands.CatFile:
        if (args.length < 3) {
          throw new Error("Hash argument required");
        }
        await GitCommand.catFile(args[2]);
        break;

      case Commands.HashObject:
        if (args.length < 3) {
          throw new Error("File path required");
        }
        await GitCommand.hashObject(args[2]);
        break;

      case Commands.LSTree: {
        // Find the hash argument (it should be the last non-flag argument)
        const hashArg = args.filter((arg) => !arg.startsWith("-")).slice(-1)[0];
        if (!hashArg) {
          throw new Error("Tree hash required");
        }

        const options: LsTreeOptions = {
          recursive: args.includes("-r") || args.includes("--recursive"),
          nameOnly: args.includes("--name-only"),
        };

        await GitCommand.lsTree(hashArg, options);
        break;
      }

      default:
        throw new Error(`Unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("An unknown error occurred");
    }
    process.exit(1);
  }
}

main();
