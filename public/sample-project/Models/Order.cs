namespace Sample.Models;

public class Order
{
    public int Id { get; set; }
    public int UserId { get; set; }
    public decimal Total { get; set; }
    public string Status { get; set; } = "pending";
    public List<OrderLine> Lines { get; set; } = new();

    public decimal RecalculateTotal()
    {
        decimal total = 0;
        foreach (var line in Lines)
        {
            total += line.UnitPrice * line.Quantity;
        }
        Total = total;
        return total;
    }
}

public class OrderLine
{
    public int Id { get; set; }
    public string Sku { get; set; } = string.Empty;
    public int Quantity { get; set; }
    public decimal UnitPrice { get; set; }
}
