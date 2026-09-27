using Sample.Models;
using Sample.Repositories;

namespace Sample.Services;

public class UserService : IUserService
{
    private readonly IUserRepository _users;
    private readonly IEmailService _email;
    private readonly IPasswordHasher _hasher;

    public UserService(IUserRepository users, IEmailService email, IPasswordHasher hasher)
    {
        _users = users;
        _email = email;
        _hasher = hasher;
    }

    public User GetUser(int id)
    {
        var user = _users.FindById(id);
        if (user is null)
        {
            throw new KeyNotFoundException($"No user with id {id}");
        }
        return user;
    }

    public User Register(LoginRequest request)
    {
        var existing = _users.FindByEmail(request.Email);
        if (existing is not null)
        {
            throw new InvalidOperationException("An account with that email already exists.");
        }

        var user = new User
        {
            Email = request.Email,
            DisplayName = request.Email.Split('@')[0],
            PasswordHash = _hasher.Hash(request.Password),
            Role = "member",
        };

        var created = _users.Add(user);
        _email.SendWelcome(created);
        return created;
    }

    public void UpdateProfile(int id, string displayName)
    {
        var user = GetUser(id);
        user.DisplayName = displayName;
        _users.Update(user);
    }

    public IReadOnlyList<User> Search(string query)
    {
        var results = new List<User>();
        foreach (var user in _users.ListAll())
        {
            if (user.DisplayName.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                user.Email.Contains(query, StringComparison.OrdinalIgnoreCase))
            {
                results.Add(user);
            }
        }
        return results;
    }
}
