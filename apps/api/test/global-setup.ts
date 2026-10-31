import { MongoBinary } from 'mongodb-memory-server';

/**
 * Resolve (and on a fresh machine, download) the mongod binary once, before test files run in parallel.
 * Without this every test file races to download the same ~60 MB file.
 */
export default async function setup(): Promise<void> {
  await MongoBinary.getPath();
}
