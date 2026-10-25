import path from 'node:path';
import { parseArgs } from 'node:util';
import { check } from './check';
import { importTranscript } from './import-transcript';
import { indexStatus } from './index-status';
import { indexRetopic } from './index-retopic';
import { indexLinksDryRun } from './index-links';
import { indexTopicsDryRun } from './index-topics';

const USAGE = `usage:
  chatmind import-transcript <transcript.json> --canvas <slug> [--data-dir <path>]
  chatmind check [--data-dir <path>]
  chatmind index status [--data-dir <path>]
  chatmind index topics --dry-run [--data-dir <path>]
  chatmind index retopic --canvas <slug> [--data-dir <path>]
  chatmind index links --dry-run [--k <n>] [--min <similarity>] [--data-dir <path>]

data dir: --data-dir, else $CHATMIND_DATA_DIR, else ~/Documents/chatmind`;

// pnpm runs package scripts with cwd = the package dir; INIT_CWD is where the user actually typed the command.
const invokedFrom = process.env.INIT_CWD ?? process.cwd();

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { canvas: { type: 'string' }, 'data-dir': { type: 'string' }, 'dry-run': { type: 'boolean' }, k: { type: 'string' }, min: { type: 'string' } },
  });
  const [command, ...rest] = positionals;
  const dataDir = values['data-dir'] === undefined ? undefined : path.resolve(invokedFrom, values['data-dir']);

  switch (command) {
    case 'check':
      return check(dataDir);
    case 'index': {
      if (rest[0] === 'status') return indexStatus(dataDir);
      if (rest[0] === 'topics' && values['dry-run']) return indexTopicsDryRun(dataDir);
      // Spec M7 §5: calibration of the link settings; --k / --min try values without touching the env.
      if (rest[0] === 'links' && values['dry-run']) return indexLinksDryRun(dataDir, { k: values.k, min: values.min });
      // Spec M6 §4: blanks only the topics the indexer wrote, so it can assign them again with tuned thresholds.
      if (rest[0] === 'retopic' && values.canvas !== undefined) return indexRetopic(values.canvas, dataDir);
      console.error(USAGE);
      return 2;
    }
    case 'import-transcript': {
      const file = rest[0];
      if (file === undefined || values.canvas === undefined) {
        console.error(USAGE);
        return 2;
      }
      const { root, count } = await importTranscript(path.resolve(invokedFrom, file), values.canvas, dataDir);
      console.log(`wrote ${count} nodes to ${path.join(root, values.canvas)}`);
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
