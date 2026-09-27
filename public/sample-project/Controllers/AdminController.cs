using Microsoft.AspNetCore.Mvc;
using Sample.Models;
using Sample.Services;

namespace Sample.Controllers;

[ApiController]
[Route("api/admin")]
public class AdminController : ControllerBase
{
    private readonly IUserService _users;
    private readonly IOrderService _orders;

    public AdminController(IUserService users, IOrderService orders)
    {
        _users = users;
        _orders = orders;
    }

    [HttpGet("users")]
    public ActionResult<IReadOnlyList<User>> AllUsers()
    {
        return Ok(_users.Search(string.Empty));
    }

    [HttpGet("revenue/{userId:int}")]
    public ActionResult<decimal> UserRevenue(int userId)
    {
        var user = _users.GetUser(userId);
        if (!user.IsAdmin())
        {
            return Forbid();
        }
        return Ok(_orders.CalculateRevenue(userId));
    }
}
