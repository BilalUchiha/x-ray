// The bundled sample project. These are real files shipped with X-Ray and are
// parsed by exactly the same engine as any folder the developer selects — the
// sample exists so the app can be explored without touching a real project.

export const SAMPLE_PROJECT_NAME = 'Sample.Api';

export const SAMPLE_PROJECT_FILES: string[] = [
  'Sample.csproj',
  'appsettings.json',
  'README.md',
  'Models/User.cs',
  'Models/Order.cs',
  'Models/AuthContracts.cs',
  'Repositories/IUserRepository.cs',
  'Repositories/UserRepository.cs',
  'Repositories/IOrderRepository.cs',
  'Services/IUserService.cs',
  'Services/UserService.cs',
  'Services/PasswordHasher.cs',
  'Services/EmailService.cs',
  'Services/AuthService.cs',
  'Services/JwtService.cs',
  'Services/OrderService.cs',
  'Controllers/UserController.cs',
  'Controllers/AuthController.cs',
  'Controllers/OrderController.cs',
  'Controllers/AdminController.cs',
  'Middleware/RequestTimingMiddleware.cs',
  'Infrastructure/Program.cs',
  'Infrastructure/ServiceCollectionExtensions.cs',
];
