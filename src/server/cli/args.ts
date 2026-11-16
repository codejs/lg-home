export const USAGE = `Usage: npm run add_user -- <username> [--password <password>] [--force]

Options:
  --password, -p <password>  Password to set (otherwise you are prompted)
  --force, -f                Update the password if the user already exists
  --help, -h                 Show this help`;

export interface AddUserArgs {
  username?: string;
  password?: string;
  force: boolean;
  help: boolean;
}

/** Invalid command line; the message includes the usage text. */
export class UsageError extends Error {
  override name = "UsageError";
}

export function parseArgs(argv: readonly string[]): AddUserArgs {
  const args: AddUserArgs = { force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--force" || arg === "-f") args.force = true;
    else if (arg === "--password" || arg === "-p") {
      // `-p` at the end would otherwise silently fall back to a prompt.
      if (i + 1 >= argv.length) throw new UsageError(`${arg} requires a value\n\n${USAGE}`);
      args.password = argv[++i];
    } else if (arg.startsWith("--password=")) args.password = arg.slice("--password=".length);
    else if (arg === "--") continue;
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option: ${arg}\n\n${USAGE}`);
    else if (args.username === undefined) args.username = arg;
    else throw new UsageError(`Unexpected argument: ${arg}\n\n${USAGE}`);
  }
  if (!args.help && args.username === undefined) throw new UsageError(USAGE);
  return args;
}

/**
 * First line of piped input, without its line ending. Only the newline is
 * removed: spaces are legitimate password characters and must survive.
 */
export function firstLine(input: string): string {
  return input.split(/\r?\n/, 1)[0] ?? "";
}
