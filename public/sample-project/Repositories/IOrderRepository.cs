using Sample.Models;

namespace Sample.Repositories;

public interface IOrderRepository
{
    Order? FindById(int id);
    IReadOnlyList<Order> ListForUser(int userId);
    Order Add(Order order);
}

public class OrderRepository : IOrderRepository
{
    private readonly Dictionary<int, Order> _orders = new();
    private int _nextId = 1;

    public Order? FindById(int id)
    {
        return _orders.TryGetValue(id, out var order) ? order : null;
    }

    public IReadOnlyList<Order> ListForUser(int userId)
    {
        var results = new List<Order>();
        foreach (var order in _orders.Values)
        {
            if (order.UserId == userId)
            {
                results.Add(order);
            }
        }
        return results;
    }

    public Order Add(Order order)
    {
        order.Id = _nextId++;
        _orders[order.Id] = order;
        return order;
    }
}
