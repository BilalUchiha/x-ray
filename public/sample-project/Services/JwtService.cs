using System.Text;
using Sample.Models;

namespace Sample.Services;

public interface IJwtService
{
    string CreateToken(User user);
    int? ValidateToken(string token);
}

public class JwtService : IJwtService
{
    private readonly JwtOptions _options;

    public JwtService(JwtOptions options)
    {
        _options = options;
    }

    public string CreateToken(User user)
    {
        var payload = $"{user.Id}:{user.Email}:{user.Role}";
        var signature = Sign(payload);
        return $"{Base64(payload)}.{signature}";
    }

    public int? ValidateToken(string token)
    {
        var parts = token.Split('.');
        if (parts.Length != 2)
        {
            return null;
        }
        var payload = Encoding.UTF8.GetString(Convert.FromBase64String(parts[0]));
        if (Sign(payload) != parts[1])
        {
            return null;
        }
        var id = payload.Split(':')[0];
        return int.TryParse(id, out var userId) ? userId : null;
    }

    private string Sign(string payload)
    {
        var bytes = Encoding.UTF8.GetBytes(payload + _options.Secret);
        return Convert.ToBase64String(System.Security.Cryptography.SHA256.HashData(bytes));
    }

    private static string Base64(string value)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
    }
}

public class JwtOptions
{
    public string Secret { get; set; } = "development-secret";
    public string Issuer { get; set; } = "sample";
    public int LifetimeHours { get; set; } = 8;
}
