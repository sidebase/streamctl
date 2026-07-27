// Local type shim for `write-file-atomic@8`. The runtime package ships no own
// types and `@types/write-file-atomic` is stuck at major 4 (a 4-major skew), so
// this minimal declaration models the v8 surface the CLI relies on.
declare module "write-file-atomic" {
  interface Options {
    chown?: { uid: number; gid: number } | false;
    encoding?: BufferEncoding | null;
    fsync?: boolean;
    mode?: number;
    tmpfileCreated?: (tmpfile: string) => void | Promise<void>;
  }

  type Data = string | NodeJS.ArrayBufferView;

  function writeFileAtomic(file: string, data: Data, options?: Options | BufferEncoding): Promise<void>;
  function writeFileAtomic(file: string, data: Data, callback: (error?: Error) => void): void;
  function writeFileAtomic(
    file: string,
    data: Data,
    options: Options | BufferEncoding,
    callback: (error?: Error) => void,
  ): void;

  namespace writeFileAtomic {
    function sync(file: string, data: Data, options?: Options | BufferEncoding): void;
  }

  export = writeFileAtomic;
}
