import { prepareAndroidSearch } from './android-search-preparation.ts';

const [serial, outputDir] = process.argv.slice(2);
if (!serial || !outputDir)
  throw new Error('Usage: android-search-prepare.ts <serial> <output-dir>');
const startedAt = Date.now();
const preparation = await prepareAndroidSearch({
  serial,
  outputDir,
  startedAt,
  deadline: startedAt + 40_000,
});
process.exitCode = preparation.satisfied ? 0 : 2;
