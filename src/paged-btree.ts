import { compareBytes } from "./fast-binary.js";
import { EncryptedPageManager } from "./encrypted-page-manager.js";
import { PageManager, type PageDevice, type PageSize } from "./page-manager.js";
import { WotonFileError, WotonValidationError } from "./errors.js";

export interface PagedBTreeOptions {
  readonly path: string;
  readonly pageSize?: PageSize;
  readonly cachePages?: number;
  readonly encryptionPassword?: string | Buffer;
  readonly minPasswordLength?: number;
}

export interface BTreePointerValue {
  readonly pageId: number;
  readonly slot: number;
  readonly checksum: number;
}

interface LeafEntry extends BTreePointerValue {
  readonly key: string;
}

interface InternalEntry {
  readonly key: string;
  readonly child: number;
}

interface LeafNode {
  readonly type: "leaf";
  readonly pageId: number;
  next: number;
  entries: LeafEntry[];
}

interface InternalNode {
  readonly type: "internal";
  readonly pageId: number;
  firstChild: number;
  entries: InternalEntry[];
}

type BTreeNode = LeafNode | InternalNode;

interface SplitResult {
  readonly key: string;
  readonly rightPageId: number;
}

const META_MAGIC = Buffer.from("WTBI", "ascii");
const NODE_MAGIC = Buffer.from("WTBN", "ascii");
const BTREE_VERSION = 1;
const NODE_LEAF = 1;
const NODE_INTERNAL = 2;
const NO_PAGE = 0xffffffff;
const META_ROOT_OFFSET = 8;
const NODE_HEADER_SIZE = 16;

export class PagedBTree {
  private rootPageId = NO_PAGE;
  private closed = false;

  private constructor(private readonly pages: PageDevice) {}

  static async open(options: PagedBTreeOptions): Promise<PagedBTree> {
    const tree = new PagedBTree(await openPageDevice(options));
    await tree.openTree();
    return tree;
  }

  async get(key: string): Promise<BTreePointerValue | undefined> {
    this.assertOpen();
    let node = await this.readNode(this.rootPageId);

    while (node.type === "internal") {
      node = await this.readNode(childForKey(node, key));
    }

    const index = lowerBoundLeaf(node.entries, key);
    const entry = node.entries[index];

    return entry?.key === key
      ? { pageId: entry.pageId, slot: entry.slot, checksum: entry.checksum }
      : undefined;
  }

  async set(key: string, value: BTreePointerValue): Promise<void> {
    this.assertOpen();
    const split = await this.insertIntoNode(this.rootPageId, { key, ...value });

    if (split) {
      const oldRoot = this.rootPageId;
      const newRootPageId = this.pages.allocatePage();
      const root: InternalNode = {
        type: "internal",
        pageId: newRootPageId,
        firstChild: oldRoot,
        entries: [{ key: split.key, child: split.rightPageId }]
      };
      this.rootPageId = newRootPageId;
      this.writeNode(root);
      this.writeMeta();
    }
  }

  async delete(key: string): Promise<boolean> {
    this.assertOpen();
    return this.deleteFromNode(this.rootPageId, key);
  }

  async *entries(): AsyncIterable<LeafEntry> {
    this.assertOpen();
    let node = await this.leftmostLeaf();

    while (true) {
      for (const entry of node.entries) {
        yield entry;
      }

      if (node.next === NO_PAGE) {
        return;
      }

      node = await this.readNode(node.next) as LeafNode;
    }
  }

  async flush(): Promise<void> {
    this.assertOpen();
    await this.pages.flush();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    await this.flush();
    await this.pages.close();
    this.closed = true;
  }

  private async openTree(): Promise<void> {
    if (this.pages.pages === 0) {
      const metaPageId = this.pages.allocatePage();
      const rootPageId = this.pages.allocatePage();

      if (metaPageId !== 0) {
        throw new WotonFileError("BTree metadata page must be page 0.");
      }

      this.rootPageId = rootPageId;
      this.writeNode({
        type: "leaf",
        pageId: rootPageId,
        next: NO_PAGE,
        entries: []
      });
      this.writeMeta();
      return;
    }

    const meta = await this.pages.readPage(0);

    if (!meta.subarray(0, META_MAGIC.byteLength).equals(META_MAGIC)) {
      throw new WotonFileError("The BTree metadata page is invalid.");
    }

    const version = meta.readUInt32LE(4);

    if (version !== BTREE_VERSION) {
      throw new WotonFileError("The BTree version is not supported.");
    }

    this.rootPageId = meta.readUInt32LE(META_ROOT_OFFSET);
  }

  private writeMeta(): void {
    const page = Buffer.alloc(this.pages.size);
    META_MAGIC.copy(page, 0);
    page.writeUInt32LE(BTREE_VERSION, 4);
    page.writeUInt32LE(this.rootPageId, META_ROOT_OFFSET);
    this.pages.writePage(0, page);
  }

  private async insertIntoNode(pageId: number, entry: LeafEntry): Promise<SplitResult | undefined> {
    const node = await this.readNode(pageId);

    if (node.type === "leaf") {
      const index = lowerBoundLeaf(node.entries, entry.key);

      if (node.entries[index]?.key === entry.key) {
        node.entries[index] = entry;
      } else {
        node.entries.splice(index, 0, entry);
      }

      if (nodeFits(node, this.pages.size)) {
        this.writeNode(node);
        return undefined;
      }

      return this.splitLeaf(node);
    }

    const childPageId = childForKey(node, entry.key);
    const split = await this.insertIntoNode(childPageId, entry);

    if (!split) {
      return undefined;
    }

    const index = lowerBoundInternal(node.entries, split.key);
    node.entries.splice(index, 0, { key: split.key, child: split.rightPageId });

    if (nodeFits(node, this.pages.size)) {
      this.writeNode(node);
      return undefined;
    }

    return this.splitInternal(node);
  }

  private splitLeaf(node: LeafNode): SplitResult {
    const rightPageId = this.pages.allocatePage();
    const midpoint = Math.ceil(node.entries.length / 2);
    const rightEntries = node.entries.splice(midpoint);
    const right: LeafNode = {
      type: "leaf",
      pageId: rightPageId,
      next: node.next,
      entries: rightEntries
    };

    node.next = rightPageId;

    if (!nodeFits(node, this.pages.size) || !nodeFits(right, this.pages.size)) {
      throw new WotonValidationError("BTree leaf entry is too large for one page.");
    }

    this.writeNode(node);
    this.writeNode(right);
    return {
      key: right.entries[0]!.key,
      rightPageId
    };
  }

  private splitInternal(node: InternalNode): SplitResult {
    const rightPageId = this.pages.allocatePage();
    const midpoint = Math.floor(node.entries.length / 2);
    const promoted = node.entries[midpoint]!;
    const right: InternalNode = {
      type: "internal",
      pageId: rightPageId,
      firstChild: promoted.child,
      entries: node.entries.slice(midpoint + 1)
    };

    node.entries = node.entries.slice(0, midpoint);

    if (!nodeFits(node, this.pages.size) || !nodeFits(right, this.pages.size)) {
      throw new WotonValidationError("BTree internal entry is too large for one page.");
    }

    this.writeNode(node);
    this.writeNode(right);
    return {
      key: promoted.key,
      rightPageId
    };
  }

  private async deleteFromNode(pageId: number, key: string): Promise<boolean> {
    const node = await this.readNode(pageId);

    if (node.type === "leaf") {
      const index = lowerBoundLeaf(node.entries, key);

      if (node.entries[index]?.key !== key) {
        return false;
      }

      node.entries.splice(index, 1);
      this.writeNode(node);
      return true;
    }

    return this.deleteFromNode(childForKey(node, key), key);
  }

  private async leftmostLeaf(): Promise<LeafNode> {
    let node = await this.readNode(this.rootPageId);

    while (node.type === "internal") {
      node = await this.readNode(node.firstChild);
    }

    return node;
  }

  private async readNode(pageId: number): Promise<BTreeNode> {
    const page = await this.pages.readPage(pageId);

    if (!page.subarray(0, NODE_MAGIC.byteLength).equals(NODE_MAGIC)) {
      throw new WotonFileError("The BTree node page is invalid.");
    }

    const version = page.readUInt16LE(4);
    const type = page.readUInt8(6);
    const count = page.readUInt16LE(8);
    const pointer = page.readUInt32LE(10);
    let offset = NODE_HEADER_SIZE;

    if (version !== BTREE_VERSION) {
      throw new WotonFileError("The BTree node version is not supported.");
    }

    if (type === NODE_LEAF) {
      const entries: LeafEntry[] = [];

      for (let index = 0; index < count; index += 1) {
        const key = readKey(page, offset);
        offset += 2 + Buffer.byteLength(key, "utf8");
        entries.push({
          key,
          pageId: page.readUInt32LE(offset),
          slot: page.readUInt32LE(offset + 4),
          checksum: page.readUInt32LE(offset + 8)
        });
        offset += 12;
      }

      return {
        type: "leaf",
        pageId,
        next: pointer,
        entries
      };
    }

    if (type === NODE_INTERNAL) {
      const entries: InternalEntry[] = [];

      for (let index = 0; index < count; index += 1) {
        const key = readKey(page, offset);
        offset += 2 + Buffer.byteLength(key, "utf8");
        entries.push({
          key,
          child: page.readUInt32LE(offset)
        });
        offset += 4;
      }

      return {
        type: "internal",
        pageId,
        firstChild: pointer,
        entries
      };
    }

    throw new WotonFileError("The BTree node type is not supported.");
  }

  private writeNode(node: BTreeNode): void {
    const page = Buffer.alloc(this.pages.size);
    NODE_MAGIC.copy(page, 0);
    page.writeUInt16LE(BTREE_VERSION, 4);
    page.writeUInt8(node.type === "leaf" ? NODE_LEAF : NODE_INTERNAL, 6);
    page.writeUInt16LE(node.entries.length, 8);
    page.writeUInt32LE(node.type === "leaf" ? node.next : node.firstChild, 10);

    let offset = NODE_HEADER_SIZE;

    if (node.type === "leaf") {
      for (const entry of node.entries) {
        offset = writeKey(page, offset, entry.key);
        page.writeUInt32LE(entry.pageId, offset);
        page.writeUInt32LE(entry.slot, offset + 4);
        page.writeUInt32LE(entry.checksum, offset + 8);
        offset += 12;
      }
    } else {
      for (const entry of node.entries) {
        offset = writeKey(page, offset, entry.key);
        page.writeUInt32LE(entry.child, offset);
        offset += 4;
      }
    }

    this.pages.writePage(node.pageId, page);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new WotonFileError("The BTree is already closed.");
    }
  }
}

async function openPageDevice(options: PagedBTreeOptions): Promise<PageDevice> {
  if (options.encryptionPassword) {
    return EncryptedPageManager.open({
      path: options.path,
      password: options.encryptionPassword,
      pageSize: options.pageSize,
      cachePages: options.cachePages,
      minPasswordLength: options.minPasswordLength
    });
  }

  return PageManager.open(options);
}

function childForKey(node: InternalNode, key: string): number {
  let child = node.firstChild;

  for (const entry of node.entries) {
    if (compareKeys(key, entry.key) < 0) {
      return child;
    }

    child = entry.child;
  }

  return child;
}

function lowerBoundLeaf(entries: readonly LeafEntry[], key: string): number {
  return lowerBound(entries, key);
}

function lowerBoundInternal(entries: readonly InternalEntry[], key: string): number {
  return lowerBound(entries, key);
}

function lowerBound(entries: readonly { readonly key: string }[], key: string): number {
  let low = 0;
  let high = entries.length;

  while (low < high) {
    const mid = (low + high) >>> 1;

    if (compareKeys(entries[mid]!.key, key) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function nodeFits(node: BTreeNode, pageSize: number): boolean {
  let size = NODE_HEADER_SIZE;

  for (const entry of node.entries) {
    const keySize = Buffer.byteLength(entry.key, "utf8");
    size += 2 + keySize + (node.type === "leaf" ? 12 : 4);
  }

  return size <= pageSize;
}

function compareKeys(left: string, right: string): number {
  return compareBytes(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function readKey(page: Buffer, offset: number): string {
  const length = page.readUInt16LE(offset);
  const start = offset + 2;
  return page.toString("utf8", start, start + length);
}

function writeKey(page: Buffer, offset: number, key: string): number {
  const keyBytes = Buffer.from(key, "utf8");

  if (keyBytes.byteLength > 0xffff) {
    throw new WotonValidationError("BTree keys must fit in uint16 bytes.");
  }

  page.writeUInt16LE(keyBytes.byteLength, offset);
  keyBytes.copy(page, offset + 2);
  return offset + 2 + keyBytes.byteLength;
}
