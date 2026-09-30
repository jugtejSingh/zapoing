#!/bin/sh
set -e

# The app never migrates itself. This only applies migrations that are not applied yet,
# so an existing database in /data is kept as it is.
npx drizzle-kit migrate

exec node build
