using Sample.Repositories;
using Sample.Services;

namespace Sample.Infrastructure;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddSampleApplication(this IServiceCollection services, IConfiguration configuration)
    {
        var jwtOptions = new JwtOptions();
        configuration.GetSection("Jwt").Bind(jwtOptions);
        services.AddSingleton(jwtOptions);

        services.AddSingleton<IUserRepository, UserRepository>();
        services.AddSingleton<IOrderRepository, OrderRepository>();
        services.AddSingleton<IPasswordHasher, PasswordHasher>();
        services.AddSingleton<IJwtService, JwtService>();
        services.AddSingleton<IEmailService, EmailService>();
        services.AddSingleton<IUserService, UserService>();
        services.AddSingleton<IAuthService, AuthService>();
        services.AddSingleton<IOrderService, OrderService>();

        return services;
    }
}
