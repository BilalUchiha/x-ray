using Sample.Models;

namespace Sample.Repositories;

/// <summary>
/// In-memory stand-in for a real database-backed repository. The shape mirrors
/// what an EF Core implementation would look like so the graph stays realistic.
/// </summary>
public class UserRepository : IUserRepository
{
    private readonly Dictionary<int, User> _users = new();
    private int _nextId = 1;

    public User? FindById(int id)
    {
        return _users.TryGetValue(id, out var user) ? user : null;
    }

    public User? FindByEmail(string email)
    {
        foreach (var user in _users.Values)
        {
            if (string.Equals(user.Email, email, StringComparison.OrdinalIgnoreCase))
            {
                return user;
            }
        }
        return null;
    }

    public IReadOnlyList<User> ListAll()
    {
        return _users.Values.ToList();
    }

    public User Add(User user)
    {
        user.Id = _nextId++;
        user.CreatedAt = DateTime.UtcNow;
        _users[user.Id] = user;
        return user;
    }

    public void Update(User user)
    {
        _users[user.Id] = user;
    }
}
