#!/usr/bin/env node
// Stand-in for /usr/bin/dokku in tests: records argv and returns canned output.
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_DOKKU_LOG) appendFileSync(process.env.FAKE_DOKKU_LOG, JSON.stringify(argv) + "\n");
const [command] = argv;
const positionals = argv.slice(1).filter((a) => !a.startsWith("-") && a !== "json");
const app = positionals[0];
const out = (s) => process.stdout.write(s);

if (app === "missing") {
  process.stderr.write(` !     App ${app} does not exist\n`);
  process.exit(1);
}

switch (command) {
  case "apps:list":
    out(JSON.stringify(["shop-api", "shop-web", "other"]));
    break;
  case "apps:report":
    out(JSON.stringify({ "created-at": "1700000000", dir: `/home/dokku/${app}` }));
    break;
  case "ps:report":
    out(JSON.stringify({ deployed: "true", running: "true", processes: "2" }));
    break;
  case "ps:scale":
    if (argv.includes("--format")) out(JSON.stringify([{ process_type: "web", quantity: 2 }, { process_type: "worker", quantity: 1 }]));
    else out("-----> Scaling\n");
    break;
  case "config:export":
    out(JSON.stringify({ DATABASE_URL: "postgres://x", FOO: "bar" }));
    break;
  case "config:get":
    if (positionals[1] === "FOO") out("bar\n");
    else process.exit(1);
    break;
  case "logs":
    out("2024-01-01 app[web.1]: hello\n2024-01-01 app[web.1]: world\n");
    break;
  case "git:from-image":
    if (positionals[1] === "broken:image") {
      process.stderr.write(" !     pull failed\n");
      process.exit(3);
    }
    out(`-----> Deploying ${positionals[1]}\n`);
    break;
  case "ps:rebuild":
    out("-----> Building\nstep 1\nstep 2\nstep 3\n=====> Application deployed\n");
    break;
  default:
    out(`ran ${argv.join(" ")}\n`);
}
