using Microsoft.AspNetCore.Mvc;
using Sample.Models;
using Sample.Services;

namespace Sample.Controllers;

[ApiController]
[Route("api/users")]
public class UserController : ControllerBase
{
    private readonly IUserService _users;
    private readonly IOrderService _orders;

    public UserController(IUserService users, IOrderService orders)
    {
        _users = users;
        _orders = orders;
    }

    [HttpGet("{id:int}")]
    public ActionResult<User> Get(int id)
    {
        return Ok(_users.GetUser(id));
    }

    [HttpPost("register")]
    public ActionResult<User> Register(LoginRequest request)
    {
        var user = _users.Register(request);
        return CreatedAtAction(nameof(Get), new { id = user.Id }, user);
    }

    [HttpGet("{id:int}/orders")]
    public ActionResult<IReadOnlyList<Order>> Orders(int id)
    {
        return Ok(_orders.GetOrdersForUser(id));
    }

    [HttpGet("search")]
    public ActionResult<IReadOnlyList<User>> Search([FromQuery] string q)
    {
        return Ok(_users.Search(q));
    }
}
