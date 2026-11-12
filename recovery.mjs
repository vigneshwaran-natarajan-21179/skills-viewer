import * as fs from 'node:fs/promises';
import path from 'node:path';

// A child process pins its working directory; replacing ancestor symlinks cannot redirect relative writes.
try {
  const [action, serialized] = process.argv.slice(2);
  const event = JSON.parse(serialized);
  const parent = await fs.stat('.', { bigint: true });
  if (parent.dev.toString() !== event.parent.dev || parent.ino.toString() !== event.parent.ino) {
    throw new Error('The original parent directory changed. Nothing was restored.');
  }
  const name = path.basename(event.source);
  if (name === '.' || name === '..') throw new Error('Invalid recovery location.');
  if (action === 'restore') {
    if (event.mode === 'remove-link') await fs.symlink(event.linkTarget, name, 'dir');
    else {
      await fs.mkdir(name);
      try {
        await fs.rename(event.destination, name);
      } catch (error) {
        await fs.rmdir(name);
        throw error;
      }
    }
  } else if (action === 'rollback') {
    if (event.mode === 'remove-link') await fs.unlink(name);
    else await fs.rename(name, event.destination);
  } else throw new Error('Invalid recovery action.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
