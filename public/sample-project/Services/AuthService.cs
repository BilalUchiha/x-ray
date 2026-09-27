using Sample.Models;
using Sample.Repositories;

namespace Sample.Services;

public interface IAuthService
{
    LoginResponse Login(LoginRequest request);
    User Authenticate(string email, string password);
}

public class AuthService : IAuthService
{
    private readonly IUserRepository _users;
    private readonly IPasswordHasher _hasher;
    private readonly IJwtService _jwt;

    public AuthService(IUserRepository users, IPasswordHasher hasher, IJwtService jwt)
    {
        _users = users;
        _hasher = hasher;
        _jwt = jwt;
    }

    public LoginResponse Login(LoginRequest request)
    {
        var user = Authenticate(request.Email, request.Password);
        var token = _jwt.CreateToken(user);
        return new LoginResponse
        {
            AccessToken = token,
            ExpiresAt = DateTime.UtcNow.AddHours(8),
            User = new UserSummary { Id = user.Id, DisplayName = user.DisplayName, Role = user.Role },
        };
    }

    public User Authenticate(string email, string password)
    {
        var user = _users.FindByEmail(email);
        if (user is null || !_hasher.Verify(password, user.PasswordHash))
        {
            throw new UnauthorizedAccessException("Invalid email or password.");
        }
        return user;
    }
}
