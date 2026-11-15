/**
 * Admin CLI: create (or update) a login account.
 *
 *   npm run add_user -- <username>                      # prompts for the password
 *   npm run add_user -- <username> --password <secret>  # non-interactive
 *   npm run add_user -- <username> --force              # overwrite an existing user
 *
 * The password can also be piped in (`echo secret | npm run add_user -- alice`)
 * or passed via the ADD_USER_PASSWORD environment variable.
 */
import { createInterface } from "node:readline";
import { eq } from "drizzle-orm";
import { db, runMigrations, schema } from "../db/index.js";
import { MIN_PASSWORD_LENGTH, deleteUserSessions, hashPassword, normalizeUsername } from "../auth.js";

const USAGE = `Usage: npm run add_user -- <username> [--password <password>] [--force]

Options:
  --password, -p <password>  Password to set (otherwise you are prompted)
  --force, -f                Update the password if the user already exists
  --help, -h                 Show this help`;

interface Args {
  username?: string;
  password?: string;
  force: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--force" || arg === "-f") args.force = true;
    else if (arg === "--password" || arg === "-p") args.password = argv[++i];
    else if (arg.startsWith("--password=")) args.password = arg.slice("--password=".length);
    else if (arg.startsWith("-")) fail(`Unknown option: ${arg}\n\n${USAGE}`);
    else if (args.username === undefined) args.username = arg;
    else fail(`Unexpected argument: ${arg}\n\n${USAGE}`);
  }
  return args;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Ask for a password without echoing it back to the terminal. */
function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const internal = rl as unknown as { _writeToOutput(text: string): void };
    let muted = false;
    internal._writeToOutput = (text: string) => {
      if (!muted) process.stdout.write(text);
      else if (text.includes("\n")) process.stdout.write("\n");
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

/** Read a single line from a pipe, e.g. `echo secret | npm run add_user -- alice`. */
async function readPipedPassword(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").split("\n")[0].trim();
}

async function resolvePassword(args: Args): Promise<string> {
  if (args.password !== undefined) return args.password;
  if (process.env.ADD_USER_PASSWORD) return process.env.ADD_USER_PASSWORD;
  if (!process.stdin.isTTY) return readPipedPassword();

  const password = await promptPassword("Password: ");
  const confirm = await promptPassword("Confirm password: ");
  if (password !== confirm) fail("Passwords do not match.");
  return password;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const rawUsername = args.username;
  if (!rawUsername) fail(USAGE);
  const username = normalizeUsername(rawUsername);
  if (!/^[a-z0-9._@-]{3,64}$/.test(username)) {
    fail("Username must be 3-64 characters: letters, digits, dot, dash, underscore or @.");
  }

  const password = await resolvePassword(args);
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  // The CLI can run before the server ever started, so make sure the schema exists.
  runMigrations();

  const existing = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  if (existing && !args.force) {
    fail(`User "${username}" already exists. Re-run with --force to change the password.`);
  }

  const now = new Date();
  const passwordHash = await hashPassword(password);

  if (existing) {
    db.update(schema.users).set({ passwordHash, updatedAt: now }).where(eq(schema.users.id, existing.id)).run();
    deleteUserSessions(existing.id); // force a fresh login everywhere
    console.log(`Updated password for "${username}". Existing sessions were signed out.`);
  } else {
    db.insert(schema.users).values({ username, passwordHash, createdAt: now, updatedAt: now }).run();
    console.log(`Created user "${username}".`);
  }
}

await main();
