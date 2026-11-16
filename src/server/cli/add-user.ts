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
import { runMigrations } from "../db/index.js";
import { UserInputError, provisionUser, validateUsername } from "../users.js";
import { USAGE, UsageError, firstLine, parseArgs, type AddUserArgs } from "./args.js";

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

async function readPipedPassword(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return firstLine(Buffer.concat(chunks).toString("utf8"));
}

async function resolvePassword(args: AddUserArgs): Promise<string> {
  if (args.password !== undefined) return args.password;
  if (process.env.ADD_USER_PASSWORD) return process.env.ADD_USER_PASSWORD;
  if (!process.stdin.isTTY) return readPipedPassword();

  const password = await promptPassword("Password: ");
  const confirm = await promptPassword("Confirm password: ");
  if (password !== confirm) throw new UserInputError("Passwords do not match.");
  return password;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  validateUsername(args.username!); // fail before asking for a password
  const password = await resolvePassword(args);
  // The CLI can run before the server ever started, so make sure the schema exists.
  runMigrations();
  const result = await provisionUser({ username: args.username!, password, force: args.force });
  console.log(
    result.created
      ? `Created user "${result.username}".`
      : `Updated password for "${result.username}". Existing sessions were signed out.`,
  );
}

try {
  await main();
} catch (err) {
  if (err instanceof UsageError || err instanceof UserInputError) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
