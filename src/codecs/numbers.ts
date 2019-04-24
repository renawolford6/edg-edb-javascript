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

import {ReadBuffer, WriteBuffer} from "../buffer";
import {ICodec, Codec} from "./ifaces";

const B32 = BigInt(32);

export class Int64Codec extends Codec implements ICodec {
  readonly isScalar = true;

  encode(buf: WriteBuffer, object: any): void {
    const val = <number>object;
    buf.writeInt32(8);
    buf.writeInt32(val >> 32);
    buf.writeInt32(val & 0xffffffff);
  }

  decode(buf: ReadBuffer): any {
    const hi = buf.readInt32();
    const lo = buf.readInt32();
    if (!hi) {
      return lo;
    }

    const bhi = BigInt(hi);
    const blo = BigInt(lo);
    return Number((bhi << B32) | blo);
  }
}

export class Int32Codec extends Codec implements ICodec {
  readonly isScalar = true;

  encode(buf: WriteBuffer, object: any): void {
    buf.writeInt32(4);
    buf.writeInt32(<number>object);
  }

  decode(buf: ReadBuffer): any {
    return buf.readInt32();
  }
}

export class Int16Codec extends Codec implements ICodec {
  readonly isScalar = true;

  encode(buf: WriteBuffer, object: any): void {
    buf.writeInt32(2);
    buf.writeInt16(<number>object);
  }

  decode(buf: ReadBuffer): any {
    return buf.readInt16();
  }
}
