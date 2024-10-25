#!/usr/bin/env node

import * as fs from "fs";
import * as zlib from "zlib";
import path, { join, resolve } from "path";
import crypto from "crypto";
import { promisify } from "util";
import https from "https";
import net from "net";

const inflate = promisify(zlib.inflate);
const deflate = promisify(zlib.deflate);

enum Commands {
  Init = "init",
  CatFile = "cat-file",
  HashObject = "hash-object",
  LSTree = "ls-tree",
  WriteTree = "write-tree",
  CommitTree = "commit-tree",
  Clone = "clone",
}

interface TreeEntry {
  mode: string;
  // type: string;
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

interface PackHeader {
  signature: string;
  version: number;
  numObjects: number;
}

interface PackObject {
  type: string;
  size: number;
  offset: number;
  data: Buffer;
}

class GitCloneCommand {
  private static async makeHttpRequest(
    url: string,
    headers: Record<string, string> = {},
    postData?: string
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const method = postData ? "POST" : "GET";
      const requestOptions = {
        method,
        headers: {
          "User-Agent": "git/2.0.0",
          ...headers,
        },
      };

      const req = https.request(url, requestOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      });

      req.on("error", reject);

      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }

  private static parsePackHeader(data: Buffer): { numObjects: number } {
    const signature = data.subarray(0, 4).toString("utf8");
    if (signature !== "PACK") {
      throw new Error("Invalid pack file signature");
    }
    const version = data.readUInt32BE(4);
    const numObjects = data.readUInt32BE(8);
    return { numObjects };
  }

  private static async processPackfile(
    packData: Buffer,
    gitDir: string
  ): Promise<void> {
    let offset = 12; // Skip pack header
    const { numObjects } = GitCloneCommand.parsePackHeader(packData);

    for (let i = 0; i < numObjects; i++) {
      let byte = packData[offset++];
      let type = (byte >> 4) & 7;
      let size = byte & 15;
      let shift = 4;

      while (byte & 0x80) {
        byte = packData[offset++];
        size |= (byte & 0x7f) << shift;
        shift += 7;
      }

      let objectData;
      if (type === 6 || type === 7) {
        // Skip delta objects for simplicity
        offset += size;
        continue;
      }

      const compressed = packData.subarray(offset);
      objectData = await inflate(compressed);
      offset += compressed.length;

      let objectType;
      switch (type) {
        case 1:
          objectType = "commit";
          break;
        case 2:
          objectType = "tree";
          break;
        case 3:
          objectType = "blob";
          break;
        default:
          throw new Error(`Unknown object type: ${type}`);
      }

      await GitCommand.writeGitObject(objectType, objectData);
    }
  }

  static async clone(url: string, targetDir: string): Promise<void> {
    // Create target directory and initialize git
    await fs.promises.mkdir(targetDir, { recursive: true });
    process.chdir(targetDir);
    await GitCommand.init();

    // Get repository info
    const infoUrl = `${url}/info/refs?service=git-upload-pack`;
    const refs = await GitCloneCommand.makeHttpRequest(infoUrl);

    // Parse refs and get HEAD
    const lines = refs.toString().split("\n");
    const head = lines.find((line) => line.includes("HEAD"))?.split(" ")[1];

    if (!head) {
      throw new Error("Could not find HEAD reference");
    }

    // Request packfile
    const uploadPackUrl = `${url}/git-upload-pack`;
    const wants = `0032want ${head}\n00000009done\n`;

    const packfile = await GitCloneCommand.makeHttpRequest(
      uploadPackUrl,
      {
        "Content-Type": "application/x-git-upload-pack-request",
      },
      wants
    );

    // Process packfile
    await GitCloneCommand.processPackfile(packfile, ".git");

    // Update HEAD reference
    await fs.promises.writeFile(
      path.join(".git", "HEAD"),
      `ref: refs/heads/main\n`
    );
    await fs.promises.writeFile(
      path.join(".git", "refs", "heads", "main"),
      head
    );

    // Checkout files
    const commitObj = await GitCommand.readGitObject(head);
    const { content } = await GitCommand.inflateObject(commitObj);
    const treeHash = content
      .toString()
      .split("\n")
      .find((line) => line.startsWith("tree"))
      ?.split(" ")[1];

    if (treeHash) {
      await GitCommand.checkoutTree(treeHash, ".");
    }

    console.log(`Cloned ${url} into ${targetDir}`);
  }
}

class GitCommand {
  private static GIT_DIR = ".git";
  private static AUTHOR = "Anubhab Debnath <example@email.com>";
  private static COMMITTER = "Anubhab Debnath <example@email.com>";

  static async readGitObject(hash: string): Promise<Buffer> {
    const objectPath = path.join(
      GitCommand.GIT_DIR,
      "objects",
      hash.slice(0, 2),
      hash.slice(2)
    );
    return fs.promises.readFile(objectPath);
  }

  static async inflateObject(buffer: Buffer): Promise<GitObject> {
    const inflated = await inflate(buffer);

    const nullByteIndex = inflated.indexOf(0);
    if (nullByteIndex === -1) {
      throw new Error("Invalid git object format: no null byte found");
    }

    const header = inflated.subarray(0, nullByteIndex).toString("utf-8");
    const [type, size] = header.split(" ");

    const content = inflated.subarray(nullByteIndex + 1);
    const contentSize = parseInt(size);
    if (content.length !== contentSize) {
      throw new Error(
        `Content size mismatch. Expected ${contentSize}, got ${content.length}`
      );
    }

    return { type, content };
  }

  static async writeGitObject(type: string, content: Buffer): Promise<string> {
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

  static parseTreeContent(buffer: Buffer): TreeEntry[] {
    const entries: TreeEntry[] = [];
    let position = 0;

    while (position < buffer.length) {
      // Find the space that separates mode from type+path
      let spaceIndex = buffer.indexOf(0x20, position);
      if (spaceIndex === -1) break;

      const mode = buffer.subarray(position, spaceIndex).toString("utf-8");

      // Find the null byte that separates path from hash
      let nullIndex = buffer.indexOf(0x00, spaceIndex + 1);
      if (nullIndex === -1) break;

      // Extract the name
      const name = buffer.subarray(spaceIndex + 1, nullIndex).toString("utf-8");

      // Extract the 20-byte SHA-1 hash
      const hash = buffer
        .subarray(nullIndex + 1, nullIndex + 21)
        .toString("hex");

      entries.push({ mode, hash, name });

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
          const type = entry.mode === "40000" ? "tree" : "blob";
          console.log(`${entry.mode} ${type} ${entry.hash}\t${entry.name}`);
        }

        if (options.recursive && entry.mode === "40000") {
          await GitCommand.lsTree(entry.hash, options);
        }
      }
    } catch (error) {
      console.error("Error listing tree:", error);
      process.exit(1);
    }
  }

  private static async writeTree(dirPath: string): Promise<string> {
    const entries: TreeEntry[] = [];
    const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });

    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirents) {
      const fullPath = path.join(dirPath, dirent.name);

      if (dirent.name === ".git") continue;

      if (dirent.isFile()) {
        const content = await fs.promises.readFile(fullPath);
        const hash = await GitCommand.writeGitObject("blob", content);
        entries.push({
          mode: "100644",
          name: dirent.name,
          hash,
        });
      } else if (dirent.isDirectory()) {
        const hash = await GitCommand.writeTree(fullPath);
        entries.push({
          mode: "40000",
          name: dirent.name,
          hash,
        });
      }
    }

    const treeContent = Buffer.concat(
      entries.flatMap((entry) => [
        Buffer.from(`${entry.mode} ${entry.name}\0`),
        Buffer.from(entry.hash, "hex"),
      ])
    );

    return await GitCommand.writeGitObject("tree", treeContent);
  }

  static async executeWriteTree(): Promise<string> {
    try {
      const hash = await GitCommand.writeTree(".");
      return hash;
    } catch (error) {
      console.error("Error writing tree:", error);
      process.exit(1);
    }
  }

  static async commitTree(
    treeHash: string,
    parentHash: string | null,
    message: string
  ): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const timezone = "+0530";

    const commitContent = [
      `tree ${treeHash}`,
      parentHash ? `parent ${parentHash}` : "",
      `author ${GitCommand.AUTHOR} ${timestamp} ${timezone}`,
      `committer ${GitCommand.COMMITTER} ${timestamp} ${timezone}`,
      "",
      message,
      "",
    ].join("\n");

    const hash = await GitCommand.writeGitObject(
      "commit",
      Buffer.from(commitContent)
    );

    return hash;
  }

  static async checkoutTree(
    treeHash: string,
    targetPath: string
  ): Promise<void> {
    const buffer = await GitCommand.readGitObject(treeHash);
    const { content } = await GitCommand.inflateObject(buffer);
    const entries = GitCommand.parseTreeContent(content);

    for (const entry of entries) {
      const entryPath = path.join(targetPath, entry.name);

      if (entry.mode === "40000") {
        // Directory
        await fs.promises.mkdir(entryPath, { recursive: true });
        await GitCommand.checkoutTree(entry.hash, entryPath);
      } else {
        // File
        const fileBuffer = await GitCommand.readGitObject(entry.hash);
        const { content: fileContent } = await GitCommand.inflateObject(
          fileBuffer
        );
        await fs.promises.writeFile(entryPath, fileContent);
      }
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

      case Commands.WriteTree:
        const hash = await GitCommand.executeWriteTree();
        process.stdout.write(hash);
        break;

      case Commands.CommitTree: {
        if (args.length < 3) {
          throw new Error(
            "Usage: commit-tree <tree-hash> [-p <parent-hash>] <message>"
          );
        }

        const treeHash = args[1];
        const parentIndex = args.indexOf("-p");
        const messageIndex = args.indexOf("-m");

        if (parentIndex === -1 || messageIndex === -1) {
          throw new Error(
            "Both parent hash [-p] and commit message [-m] are required"
          );
        }

        const parentHash = args[parentIndex + 1];
        const message = args[messageIndex + 1];

        const commitHash = await GitCommand.commitTree(
          treeHash,
          parentHash,
          message
        );
        process.stdout.write(commitHash);

        break;
      }

      case Commands.Clone:
        if (args.length < 3) {
          throw new Error("Usage: clone <repository-url> <target-directory>");
        }
        const repoUrl = args[1];
        const targetDir = args[2];
        await GitCloneCommand.clone(repoUrl, targetDir);
        break;

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

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

main();
