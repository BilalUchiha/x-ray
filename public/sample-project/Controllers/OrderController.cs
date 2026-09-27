using Microsoft.AspNetCore.Mvc;
using Sample.Models;
using Sample.Services;

namespace Sample.Controllers;

[ApiController]
[Route("api/orders")]
public class OrderController : ControllerBase
{
    private readonly IOrderService _orders;
    private readonly IUserService _users;

    public OrderController(IOrderService orders, IUserService users)
    {
        _orders = orders;
        _users = users;
    }

    [HttpPost]
    public ActionResult<Order> Place([FromBody] PlaceOrderCommand command)
    {
        var order = _orders.PlaceOrder(command.UserId, command.Lines);
        return Ok(order);
    }

    [HttpGet("revenue/{userId:int}")]
    public ActionResult<decimal> Revenue(int userId)
    {
        return Ok(_orders.CalculateRevenue(userId));
    }
}

public class PlaceOrderCommand
{
    public int UserId { get; set; }
    public List<OrderLine> Lines { get; set; } = new();
}
