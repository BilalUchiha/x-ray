using Sample.Models;

namespace Sample.Services;

public interface IEmailService
{
    void SendWelcome(User user);
    void SendPasswordReset(User user, string token);
}

public class EmailService : IEmailService
{
    private readonly ILogger<EmailService> _logger;

    public EmailService(ILogger<EmailService> logger)
    {
        _logger = logger;
    }

    public void SendWelcome(User user)
    {
        _logger.LogInformation("Welcome email queued for {Email}", user.Email);
    }

    public void SendPasswordReset(User user, string token)
    {
        _logger.LogInformation("Password reset email queued for {Email}", user.Email);
    }
}
