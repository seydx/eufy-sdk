/**
 * `protobufjs`, imported statically.
 *
 * A static import lets a bundler follow the dependency, including one that emits CommonJS, where
 * `import.meta.url` is empty and a `createRequire` built from it throws at module load. The module is
 * evaluated at import as a result, not on first use.
 */
import protobuf from "protobufjs";

/** The `protobufjs` module shape. */
type Protobuf = typeof import("protobufjs");

/** The engine. The ONLY runtime reference to `protobufjs` here. */
export function protobufjs(): Protobuf {
  return protobuf as Protobuf;
}
