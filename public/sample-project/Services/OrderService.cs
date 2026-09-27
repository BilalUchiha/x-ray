using Sample.Models;
using Sample.Repositories;

namespace Sample.Services;

public interface IOrderService
{
    Order PlaceOrder(int userId, List<OrderLine> lines);
    IReadOnlyList<Order> GetOrdersForUser(int userId);
    decimal CalculateRevenue(int userId);
}

public class OrderService : IOrderService
{
    private readonly IOrderRepository _orders;
    private readonly IUserService _users;
    private readonly IEmailService _email;

    public OrderService(IOrderRepository orders, IUserService users, IEmailService email)
    {
        _orders = orders;
        _users = users;
        _email = email;
    }

    public Order PlaceOrder(int userId, List<OrderLine> lines)
    {
        var user = _users.GetUser(userId);
        var order = new Order { UserId = user.Id, Lines = lines, Status = "pending" };
        order.RecalculateTotal();
        var saved = _orders.Add(order);
        _email.SendWelcome(user);
        return saved;
    }

    public IReadOnlyList<Order> GetOrdersForUser(int userId)
    {
        return _orders.ListForUser(userId);
    }

    public decimal CalculateRevenue(int userId)
    {
        decimal revenue = 0;
        foreach (var order in GetOrdersForUser(userId))
        {
            revenue += order.Total;
        }
        return revenue;
    }
}
