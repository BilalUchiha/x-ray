# Sample project

A tiny layered C# service used by X-Ray's onboarding so the app can be explored
without pointing it at a real project folder.

- `Controllers/` — HTTP surface
- `Services/` — business logic
- `Repositories/` — data access
- `Models/` — entities and DTOs
- `Middleware/` — pipeline
- `Infrastructure/` — bootstrap and DI

It is deliberately small, but every relationship X-Ray draws comes from these
files: nothing here is synthetic graph data.
