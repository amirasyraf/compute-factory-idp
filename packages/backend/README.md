# Vendy backend

This package assembles the Vendy Backstage backend. Custom behavior lives in
`plugins/cf-backend`; the runtime provides password authentication, team permissions,
SSH certificate signing, and workflow progress streaming.

## Development

To run the example backend, first go to the project root and run

```bash
yarn install
```

You should only need to do this once.

After that, go to the `packages/backend` directory and run

```bash
yarn start
```

If you want to override any configuration locally, for example adding any secrets,
you can do so in `app-config.local.yaml`.

The backend starts up on port 7007 per default.

## Populating The Catalog

If you want to use the catalog functionality, you need to add so called
locations to the backend. These are places where the backend can find some
entity descriptor data to consume and serve. For more information, see
[Software Catalog Overview - Adding Components to the Catalog](https://backstage.io/docs/features/software-catalog/#adding-components-to-the-catalog).

To get started quickly, this template already includes some statically configured example locations
in `app-config.yaml` under `catalog.locations`. You can remove and replace these locations as you
like, and also override them for local development in `app-config.local.yaml`.

## Authentication

The POC uses the custom username/password provider in `plugins/cf-backend`. Password hashes are supplied
through `IDP_USERS_B64`; sessions are signed and backed by an HttpOnly cookie.

## Documentation

- [Backstage Readme](https://github.com/backstage/backstage/blob/master/README.md)
- [Backstage Documentation](https://backstage.io/docs)
