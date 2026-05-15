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
BB_SERVER_URL=http://127.0.0.1:38886 \
BB_HOST_ID=<host-id> \
BB_HOST_ENROLL_KEY=<join-code> \
npx bb-app host-daemon
```

Use the host ID and join code from the server/app join command. After the
daemon is enrolled, `BB_HOST_ENROLL_KEY` can be omitted for the same data
directory.
