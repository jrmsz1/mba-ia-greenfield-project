// Runs per test file of the `unit` Jest project, after `dotenv/config`.
// Unit tests must not reach PostgreSQL: point DB_HOST at a reserved,
// never-resolvable name (RFC 2606 ".invalid") so an accidental connection
// fails loudly instead of touching the development database.
process.env.DB_HOST = 'db-access-forbidden-in-unit-tests.invalid';
