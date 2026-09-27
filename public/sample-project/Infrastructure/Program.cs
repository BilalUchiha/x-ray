using Sample.Infrastructure;
using Sample.Middleware;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddSampleApplication(builder.Configuration);

var app = builder.Build();

app.UseMiddleware<RequestTimingMiddleware>();
app.MapControllers();

app.Run();
