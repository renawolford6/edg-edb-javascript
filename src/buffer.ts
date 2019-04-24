/*!
 * This source file is part of the EdgeDB open source project.
 *
 * Copyright 2019-present MagicStack Inc. and the EdgeDB authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import char, * as chars from "./chars";
import {RingBuffer} from "./ring";
import {Buffer} from "buffer";

/* WriteBuffer over-allocation */
const BUFFER_INC_SIZE: number = 4096;

/* Max number of recv buffers that can be queued for
 * reading.
 */
const BUFFER_RING_CAPACITY: number = 1024;

const EMPTY_BUFFER = Buffer.allocUnsafe(0);

export class BufferError extends Error {}

export class WriteBuffer {
  public buffer: Buffer;
  private size: number;
  private pos: number;

  constructor() {
    this.size = BUFFER_INC_SIZE;
    this.pos = 0;
    this.buffer = Buffer.allocUnsafe(this.size);
  }

  get position(): number {
    return this.pos;
  }

  reset(): void {
    this.pos = 0;
  }

  private ensureAlloced(extraLength: number): void {
    const newSize: number = this.pos + extraLength;
    if (newSize > this.size) {
      this.__realloc(newSize);
    }
  }

  private __realloc(newSize: number): void {
    newSize += BUFFER_INC_SIZE;
    const newBuffer = Buffer.allocUnsafe(newSize);
    this.buffer.copy(newBuffer, 0, 0, this.pos);
    this.buffer = newBuffer;
  }

  writeChar(ch: char): this {
    this.ensureAlloced(1);
    this.buffer.writeUInt8(ch, this.pos);
    this.pos++;
    return this;
  }

  writeString(s: string): this {
    const buf: Buffer = Buffer.from(s, "utf-8");
    this.ensureAlloced(buf.length + 4);
    this.buffer.writeInt32BE(buf.length, this.pos);
    this.pos += 4;
    buf.copy(this.buffer, this.pos, 0, buf.length);
    this.pos += buf.length;
    return this;
  }

  writeInt16(i: number): this {
    this.ensureAlloced(2);
    this.buffer.writeInt16BE(i, this.pos);
    this.pos += 2;
    return this;
  }

  writeInt32(i: number): this {
    this.ensureAlloced(4);
    this.buffer.writeInt32BE(i, this.pos);
    this.pos += 4;
    return this;
  }

  writeUInt16(i: number): this {
    this.ensureAlloced(2);
    this.buffer.writeUInt16BE(i, this.pos);
    this.pos += 2;
    return this;
  }

  writeUInt32(i: number): this {
    this.ensureAlloced(4);
    this.buffer.writeUInt32BE(i, this.pos);
    this.pos += 4;
    return this;
  }

  writeBuffer(buf: Buffer): this {
    const len = buf.length;
    this.ensureAlloced(len);
    buf.copy(this.buffer, this.pos, 0, len);
    this.pos += len;
    return this;
  }

  unwrap(): Buffer {
    return this.buffer.slice(0, this.pos);
  }
}

export class WriteMessageBuffer {
  private buffer: WriteBuffer;
  private messagePos: number;

  constructor() {
    this.messagePos = -1;
    this.buffer = new WriteBuffer();
  }

  reset(): void {
    this.buffer.reset();
  }

  beginMessage(mtype: char): this {
    if (this.messagePos >= 0) {
      throw new BufferError(
        "cannot begin a new message: the previous message is not finished"
      );
    }
    this.messagePos = this.buffer.position;
    this.buffer.writeChar(mtype);
    this.buffer.writeInt32(0);
    return this;
  }

  endMessage(): this {
    if (this.messagePos < 0) {
      throw new BufferError("cannot end the message: no current message");
    }

    this.buffer.buffer.writeInt32BE(
      this.buffer.position - this.messagePos - 1,
      this.messagePos + 1
    );
    this.messagePos = -1;
    return this;
  }

  writeChar(ch: char): this {
    if (this.messagePos < 0) {
      throw new BufferError("cannot writeChar: no current message");
    }
    this.buffer.writeChar(ch);
    return this;
  }

  writeString(s: string): this {
    if (this.messagePos < 0) {
      throw new BufferError("cannot writeString: no current message");
    }
    this.buffer.writeString(s);
    return this;
  }

  writeInt16(i: number): this {
    if (this.messagePos < 0) {
      throw new BufferError("cannot writeInt16: no current message");
    }
    this.buffer.writeInt16(i);
    return this;
  }

  writeInt32(i: number): this {
    if (this.messagePos < 0) {
      throw new BufferError("cannot writeInt32: no current message");
    }
    this.buffer.writeInt32(i);
    return this;
  }

  writeUInt16(i: number): this {
    if (this.messagePos < 0) {
      throw new BufferError("cannot writeInt16: no current message");
    }
    this.buffer.writeUInt16(i);
    return this;
  }

  writeUInt32(i: number): this {
    if (this.messagePos < 0) {
      throw new BufferError("cannot writeInt32: no current message");
    }
    this.buffer.writeUInt32(i);
    return this;
  }

  writeBuffer(buf: Buffer): this {
    if (this.messagePos < 0) {
      throw new BufferError("cannot writeBuffer: no current message");
    }
    this.buffer.writeBuffer(buf);
    return this;
  }

  writeSync(): this {
    if (this.messagePos >= 0) {
      throw new BufferError(
        "cannot writeSync: the previous message is not finished"
      );
    }
    this.buffer.writeBuffer(SYNC_MESSAGE);
    return this;
  }

  writeFlush(): this {
    if (this.messagePos >= 0) {
      throw new BufferError(
        "cannot writeFlush: the previous message is not finished"
      );
    }
    this.buffer.writeBuffer(FLUSH_MESSAGE);
    return this;
  }

  unwrap(): Buffer {
    if (this.messagePos >= 0) {
      throw new BufferError(
        "cannot unwrap: an unfinished message is in the buffer"
      );
    }
    return this.buffer.unwrap();
  }
}

const SYNC_MESSAGE = new WriteMessageBuffer()
  .beginMessage(chars.$S)
  .endMessage()
  .unwrap();

const FLUSH_MESSAGE = new WriteMessageBuffer()
  .beginMessage(chars.$H)
  .endMessage()
  .unwrap();

export class ReadMessageBuffer {
  private bufs: RingBuffer<Buffer>;
  private len: number;

  private buf0: Buffer | null;
  private pos0: number;
  private len0: number;

  private curMessageType: char;
  private curMessageLen: number;
  private curMessageLenUnread: number;
  private curMessageReady: boolean;

  constructor() {
    this.bufs = new RingBuffer<Buffer>({capacity: BUFFER_RING_CAPACITY});
    this.buf0 = null;
    this.pos0 = 0;
    this.len0 = 0;
    this.len = 0;

    this.curMessageType = 0;
    this.curMessageLen = 0;
    this.curMessageLenUnread = 0;
    this.curMessageReady = false;
  }

  get length(): number {
    return this.len;
  }

  feed(buf: Buffer): boolean {
    if (
      this.buf0 == null ||
      (this.pos0 === this.len0 && this.bufs.length === 0)
    ) {
      this.buf0 = buf;
      this.len0 = buf.length;
      this.pos0 = 0;
      this.len = this.len0;
    } else {
      this.bufs.enq(buf);
      this.len += buf.length;
    }

    return this.bufs.full;
  }

  private ensureFirstBuf(): Buffer {
    if (this.pos0 === this.len0) {
      this.__nextBuf();
    }
    const buf0 = this.buf0;
    if (buf0 == null || buf0.length < 1) {
      throw new BufferError("empty buffer");
    }
    return buf0;
  }

  private checkOverread(size: number): void {
    if (this.curMessageLenUnread < size || size > this.len) {
      throw new BufferError("buffer overread");
    }
  }

  private __nextBuf(): void {
    // Only called from ensureFirstBuf().  This part
    // is factored out to let ensureFirstBuf() be inlined.
    const nextBuf = this.bufs.deq();
    if (nextBuf == null) {
      throw new BufferError("buffer overread");
    }

    this.buf0 = nextBuf;
    this.pos0 = 0;
    this.len0 = nextBuf.length;
  }

  private discardBuffer(size: number): void {
    this.ensureFirstBuf();
    while (true) {
      if (this.pos0 + size > this.len0) {
        const nread = this.len0 - this.pos0;

        this.pos0 = this.len0;
        this.len -= nread;
        size -= nread;

        this.ensureFirstBuf();
      } else {
        this.pos0 += size;
        this.len -= size;
        break;
      }
    }
  }

  private _finishMessage() {
    this.curMessageLen = 0;
    this.curMessageLenUnread = 0;
    this.curMessageReady = false;
    this.curMessageType = 0;
  }

  private __readBufferCopy(buf0: Buffer, size: number): Buffer {
    const ret = Buffer.allocUnsafe(size);
    let retPos = 0;

    while (true) {
      if (this.pos0 + size > this.len0) {
        const nread = this.len0 - this.pos0;

        buf0.copy(ret, retPos, this.pos0, nread);
        retPos += nread;

        this.pos0 = this.len0;
        this.len -= nread;
        size -= nread;

        buf0 = this.ensureFirstBuf();
      } else {
        buf0.copy(ret, retPos, this.pos0, size);
        this.pos0 += size;
        this.len -= size;
        break;
      }
    }

    return ret;
  }

  private _readBuffer(size: number): Buffer {
    const buf0 = this.ensureFirstBuf();

    if (size === 0) {
      return EMPTY_BUFFER;
    }

    if (this.pos0 + size < this.len0) {
      // If the requested *size* fits in the first buffer
      // do a slice operation.
      const ret = buf0.slice(this.pos0, this.pos0 + size);
      this.pos0 += size;
      this.len -= size;
      return ret;
    }

    return this.__readBufferCopy(buf0, size);
  }

  readBuffer(size: number): Buffer {
    this.checkOverread(size);
    const buf = this._readBuffer(size);
    this.curMessageLenUnread -= size;
    return buf;
  }

  readUUID(): string {
    const buf = this.readBuffer(16);
    return buf.toString("hex");
  }

  readChar(): char {
    this.checkOverread(1);
    const buf0 = this.ensureFirstBuf();
    const ret = buf0.readUInt8(this.pos0);
    this.pos0++;
    this.curMessageLenUnread--;
    this.len--;
    return ret;
  }

  readInt16(): number {
    this.checkOverread(2);
    const buf0 = this.ensureFirstBuf();

    if (this.pos0 + 2 < this.len0) {
      const ret = buf0.readInt16BE(this.pos0);
      this.pos0 += 2;
      this.curMessageLenUnread -= 2;
      this.len -= 2;
      return ret;
    }

    const buf = this._readBuffer(2);
    this.curMessageLenUnread -= 2;
    return buf.readInt16BE(0);
  }

  readInt32(): number {
    this.checkOverread(4);
    const buf0 = this.ensureFirstBuf();

    if (this.pos0 + 4 < this.len0) {
      const ret = buf0.readInt32BE(this.pos0);
      this.pos0 += 4;
      this.curMessageLenUnread -= 4;
      this.len -= 4;
      return ret;
    }

    const buf = this._readBuffer(4);
    this.curMessageLenUnread -= 4;
    return buf.readInt32BE(0);
  }

  readUInt16(): number {
    this.checkOverread(2);
    const buf0 = this.ensureFirstBuf();

    if (this.pos0 + 2 < this.len0) {
      const ret = buf0.readUInt16BE(this.pos0);
      this.pos0 += 2;
      this.curMessageLenUnread -= 2;
      this.len -= 2;
      return ret;
    }

    const buf = this._readBuffer(2);
    this.curMessageLenUnread -= 2;
    return buf.readUInt16BE(0);
  }

  readUInt32(): number {
    this.checkOverread(4);
    const buf0 = this.ensureFirstBuf();

    if (this.pos0 + 4 < this.len0) {
      const ret = buf0.readUInt32BE(this.pos0);
      this.pos0 += 4;
      this.curMessageLenUnread -= 4;
      this.len -= 4;
      return ret;
    }

    const buf = this._readBuffer(4);
    this.curMessageLenUnread -= 4;
    return buf.readUInt32BE(0);
  }

  readString(): string {
    const len = this.readInt32();
    const buf = this.readBuffer(len);
    return buf.toString("utf-8");
  }

  readLenPrefixedBuffer(): Buffer {
    const len = this.readInt32();
    return this.readBuffer(len);
  }

  takeMessage(): boolean {
    if (this.curMessageReady) {
      return true;
    }

    if (this.curMessageType === 0) {
      if (this.len < 1) {
        return false;
      }
      const buf0 = this.ensureFirstBuf();
      this.curMessageType = buf0.readUInt8(this.pos0);
      this.pos0++;
      this.len--;
    }

    if (this.curMessageLen === 0) {
      if (this.len < 4) {
        return false;
      }
      const buf0 = this.ensureFirstBuf();
      if (this.pos0 + 4 < this.len0) {
        this.curMessageLen = buf0.readInt32BE(this.pos0);
        this.pos0 += 4;
        this.len -= 4;
      } else {
        const buf = this._readBuffer(4);
        this.curMessageLen = buf.readInt32BE(0);
      }

      this.curMessageLenUnread = this.curMessageLen - 4;
    }

    if (this.len < this.curMessageLenUnread) {
      return false;
    }

    this.curMessageReady = true;
    return true;
  }

  getMessageType(): char {
    return this.curMessageType;
  }

  takeMessageType(mtype: char): boolean {
    if (this.curMessageReady) {
      return this.curMessageType === mtype;
    }

    if (this.len >= 1) {
      const buf0 = this.ensureFirstBuf();
      const unreadMessageType = buf0.readUInt8(this.pos0);
      return mtype === unreadMessageType && this.takeMessage();
    }

    return false;
  }

  putMessage(): void {
    if (!this.curMessageReady) {
      throw new BufferError("cannot put message: no message taken");
    }
    if (this.curMessageLenUnread !== this.curMessageLen - 4) {
      throw new BufferError("cannot put message: message is partially read");
    }
    this.curMessageReady = false;
  }

  discardMessage(): void {
    if (!this.curMessageReady) {
      throw new BufferError("no message to discard");
    }
    if (this.curMessageLenUnread > 0) {
      this.discardBuffer(this.curMessageLenUnread);
    }
    this._finishMessage();
  }

  consumeMessage(): Buffer {
    if (!this.curMessageReady) {
      throw new BufferError("no message to consume");
    }

    let buf: Buffer;
    if (this.curMessageLenUnread > 0) {
      buf = this._readBuffer(this.curMessageLenUnread);
      this.curMessageLenUnread = 0;
    } else {
      buf = EMPTY_BUFFER;
    }

    this._finishMessage();
    return buf;
  }

  consumeMessageInto(frb: ReadBuffer) {
    if (!this.curMessageReady) {
      throw new BufferError("no message to consume");
    }

    if (this.curMessageLenUnread > 0) {
      if (this.pos0 + this.curMessageLenUnread < this.len0) {
        const len = this.pos0 + this.curMessageLenUnread;
        ReadBuffer.slice(frb, this.buf0!, this.pos0, len);
        this.pos0 = len;
        this.len -= this.curMessageLenUnread;
      } else {
        const buf = this._readBuffer(this.curMessageLenUnread);
        ReadBuffer.init(frb, buf);
      }
      this.curMessageLenUnread = 0;
    } else {
      ReadBuffer.init(frb, EMPTY_BUFFER);
    }

    this._finishMessage();
  }

  finishMessage(): void {
    if (this.curMessageType === 0 || !this.curMessageReady) {
      // The message has already been finished (e.g. by consumeMessage()),
      // or has been put back by putMessage().
      return;
    }

    if (this.curMessageLenUnread) {
      throw new BufferError(
        `cannot finishMessage: unread data in message ` +
          `"${chars.chr(this.curMessageType)}"`
      );
    }

    this._finishMessage();
  }
}

export class ReadBuffer {
  private buffer: Buffer;
  private pos: number;
  private len: number;

  constructor(buf: Buffer) {
    this.buffer = buf;
    this.len = buf.length;
    this.pos = 0;
  }

  get length(): number {
    return this.len - this.pos;
  }

  discard(size: number) {
    if (this.pos + size > this.len) {
      throw new BufferError("buffer overread");
    }
    this.pos += size;
  }

  readUInt8(): number {
    if (this.pos + 1 > this.len) {
      throw new BufferError("buffer overread");
    }
    const num = this.buffer.readUInt8(this.pos);
    this.pos++;
    return num;
  }

  readUInt16(): number {
    if (this.pos + 2 > this.len) {
      throw new BufferError("buffer overread");
    }
    const num = this.buffer.readUInt16BE(this.pos);
    this.pos += 2;
    return num;
  }

  readInt8(): number {
    if (this.pos + 1 > this.len) {
      throw new BufferError("buffer overread");
    }
    const num = this.buffer.readInt8(this.pos);
    this.pos++;
    return num;
  }

  readInt16(): number {
    if (this.pos + 2 > this.len) {
      throw new BufferError("buffer overread");
    }
    const num = this.buffer.readInt16BE(this.pos);
    this.pos += 2;
    return num;
  }

  readInt32(): number {
    if (this.pos + 4 > this.len) {
      throw new BufferError("buffer overread");
    }
    const num = this.buffer.readInt32BE(this.pos);
    this.pos += 4;
    return num;
  }

  readUInt32(): number {
    if (this.pos + 4 > this.len) {
      throw new BufferError("buffer overread");
    }
    const num = this.buffer.readUInt32BE(this.pos);
    this.pos += 4;
    return num;
  }

  readUUID(): string {
    if (this.pos + 16 > this.len) {
      throw new BufferError("buffer overread");
    }
    const buf = this.buffer.slice(this.pos, this.pos + 16);
    this.pos += 16;
    return buf.toString("hex");
  }

  consumeAsString(): string {
    const res = this.buffer.toString("utf8", this.pos, this.len);
    this.pos = this.len;
    return res;
  }

  consumeInto(frb: ReadBuffer, size: number): void {
    frb.buffer = this.buffer;
    frb.pos = this.pos;
    frb.len = this.pos + size;
    this.pos += size;
  }

  static init(frb: ReadBuffer, buffer: Buffer): void {
    frb.buffer = buffer;
    frb.pos = 0;
    frb.len = buffer.length;
  }

  static slice(
    frb: ReadBuffer,
    buffer: Buffer,
    pos: number,
    len: number
  ): void {
    frb.buffer = buffer;
    frb.pos = pos;
    frb.len = len;
  }

  static alloc(): ReadBuffer {
    return new this(EMPTY_BUFFER);
  }
}
