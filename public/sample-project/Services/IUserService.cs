using Sample.Models;

namespace Sample.Services;

public interface IUserService
{
    User GetUser(int id);
    User Register(LoginRequest request);
    void UpdateProfile(int id, string displayName);
    IReadOnlyList<User> Search(string query);
}
