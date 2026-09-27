using Microsoft.AspNetCore.Mvc;
using Sample.Models;
using Sample.Services;

namespace Sample.Controllers;

[ApiController]
[Route("api/auth")]
public class AuthController : ControllerBase
{
    private readonly IAuthService _auth;
    private readonly IJwtService _jwt;
    private readonly IUserService _users;

    public AuthController(IAuthService auth, IJwtService jwt, IUserService users)
    {
        _auth = auth;
        _jwt = jwt;
        _users = users;
    }

    [HttpPost("login")]
    public ActionResult<LoginResponse> Login(LoginRequest request)
    {
        var response = _auth.Login(request);
        return Ok(response);
    }

    [HttpGet("me")]
    public ActionResult<User> Me([FromHeader(Name = "Authorization")] string authorization)
    {
        var token = authorization.Replace("Bearer ", string.Empty);
        var userId = _jwt.ValidateToken(token);
        if (userId is null)
        {
            return Unauthorized();
        }
        return Ok(_users.GetUser(userId.Value));
    }
}
