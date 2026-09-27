using Sample.Models;

namespace Sample.Repositories;

public interface IUserRepository
{
    User? FindById(int id);
    User? FindByEmail(string email);
    IReadOnlyList<User> ListAll();
    User Add(User user);
    void Update(User user);
}
