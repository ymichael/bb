# bb-app

bb launcher for npm exec flows.

```bash
npx bb-app
```

This starts the bb server, serves the web app, enrolls a local host daemon when
needed, and keeps both processes running until interrupted.

Run the bundled CLI with the `bb` bin from the same package:

```bash
npx --package bb-app bb status
npx --package bb-app bb thread list
```

To run only a host daemon against an existing server:

```bash
npx bb-app host-daemon join --server-url http://127.0.0.1:38886
```

The join command requests enrollment material from the server, starts the
daemon, and stores the server URL in the bb data directory config. After the
daemon is enrolled, use `npx bb-app host-daemon` for the same data directory.
