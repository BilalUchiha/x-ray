// Dev utility: writes realistic project fixtures to a directory so the scanner
// and graph can be exercised against real-world layouts.
//
//   npx esbuild scripts/make-fixtures.ts --bundle --platform=node --format=esm --external:node:* --outfile=/tmp/mf.mjs && node /tmp/mf.mjs /tmp/xray-fixtures

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CS_USER = `namespace MyApp.Domain.Entities;

public class User
{
    public int Id { get; set; }
    public string Email { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string PasswordHash { get; set; } = string.Empty;
    public bool IsActive { get; set; } = true;
    public List<Order> Orders { get; set; } = new();

    public bool CanLogin()
    {
        return IsActive && !string.IsNullOrEmpty(PasswordHash);
    }
}
`;

const CS_ORDER = `namespace MyApp.Domain.Entities;

public class Order
{
    public int Id { get; set; }
    public int UserId { get; set; }
    public decimal Total { get; set; }
    public DateTime PlacedAt { get; set; }
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
`;

const CS_IUSER_REPO = `using MyApp.Domain.Entities;

namespace MyApp.Domain.Interfaces;

public interface IUserRepository
{
    User? FindById(int id);
    User? FindByEmail(string email);
    IReadOnlyList<User> ListAll();
    User Add(User user);
    void Update(User user);
}
`;

const CS_IORDER_REPO = `using MyApp.Domain.Entities;

namespace MyApp.Domain.Interfaces;

public interface IOrderRepository
{
    Order? FindById(int id);
    IReadOnlyList<Order> ListForUser(int userId);
    Order Add(Order order);
}
`;

const CS_USER_SERVICE = `using MyApp.Domain.Entities;
using MyApp.Domain.Interfaces;

namespace MyApp.Application.Services;

public class UserService : IUserService
{
    private readonly IUserRepository _users;
    private readonly IPasswordHasher _hasher;
    private readonly IEmailSender _email;

    public UserService(IUserRepository users, IPasswordHasher hasher, IEmailSender email)
    {
        _users = users;
        _hasher = hasher;
        _email = email;
    }

    public User GetUser(int id)
    {
        var user = _users.FindById(id);
        if (user is null)
        {
            throw new KeyNotFoundException($"User {id} was not found.");
        }
        return user;
    }

    public User Register(string email, string password)
    {
        var existing = _users.FindByEmail(email);
        if (existing is not null)
        {
            throw new InvalidOperationException("Email already registered.");
        }

        var user = new User
        {
            Email = email,
            PasswordHash = _hasher.Hash(password),
        };

        var created = _users.Add(user);
        _email.SendWelcome(created);
        return created;
    }
}

public interface IUserService
{
    User GetUser(int id);
    User Register(string email, string password);
}

public interface IPasswordHasher
{
    string Hash(string password);
    bool Verify(string password, string hash);
}

public interface IEmailSender
{
    void SendWelcome(User user);
}
`;

const CS_ORDER_SERVICE = `using MyApp.Domain.Entities;
using MyApp.Domain.Interfaces;

namespace MyApp.Application.Services;

public class OrderService : IOrderService
{
    private readonly IOrderRepository _orders;
    private readonly IUserService _users;

    public OrderService(IOrderRepository orders, IUserService users)
    {
        _orders = orders;
        _users = users;
    }

    public Order Place(int userId, List<OrderLine> lines)
    {
        var user = _users.GetUser(userId);
        var order = new Order { UserId = user.Id, Lines = lines };
        order.RecalculateTotal();
        return _orders.Add(order);
    }

    public decimal RevenueFor(int userId)
    {
        decimal total = 0;
        foreach (var order in _orders.ListForUser(userId))
        {
            total += order.Total;
        }
        return total;
    }
}

public interface IOrderService
{
    Order Place(int userId, List<OrderLine> lines);
    decimal RevenueFor(int userId);
}
`;

const CS_USERS_CONTROLLER = `using Microsoft.AspNetCore.Mvc;
using MyApp.Application.Services;
using MyApp.Domain.Entities;

namespace MyApp.Api.Controllers;

[ApiController]
[Route("api/users")]
public class UsersController : ControllerBase
{
    private readonly IUserService _users;
    private readonly IOrderService _orders;

    public UsersController(IUserService users, IOrderService orders)
    {
        _users = users;
        _orders = orders;
    }

    [HttpGet("{id:int}")]
    public ActionResult<User> Get(int id)
    {
        return Ok(_users.GetUser(id));
    }

    [HttpPost]
    public ActionResult<User> Create(RegisterUserCommand command)
    {
        var user = _users.Register(command.Email, command.Password);
        return CreatedAtAction(nameof(Get), new { id = user.Id }, user);
    }

    [HttpGet("{id:int}/revenue")]
    public ActionResult<decimal> Revenue(int id)
    {
        return Ok(_orders.RevenueFor(id));
    }
}

public class RegisterUserCommand
{
    public string Email { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
}
`;

const CS_ORDERS_CONTROLLER = `using Microsoft.AspNetCore.Mvc;
using MyApp.Application.Services;
using MyApp.Domain.Entities;

namespace MyApp.Api.Controllers;

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    private readonly IOrderService _orders;
    private readonly IUserService _users;

    public OrdersController(IOrderService orders, IUserService users)
    {
        _orders = orders;
        _users = users;
    }

    [HttpGet("{userId:int}")]
    public ActionResult<decimal> Revenue(int userId)
    {
        var user = _users.GetUser(userId);
        if (!user.CanLogin())
        {
            return Forbid();
        }
        return Ok(_orders.RevenueFor(userId));
    }
}
`;

const CS_DBCONTEXT = `using Microsoft.EntityFrameworkCore;
using MyApp.Domain.Entities;

namespace MyApp.Infrastructure.Persistence;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options)
    {
    }

    public DbSet<User> Users => Set<User>();
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<User>().HasIndex(u => u.Email).IsUnique();
        base.OnModelCreating(modelBuilder);
    }
}
`;

const CS_USER_REPO_IMPL = `using MyApp.Domain.Entities;
using MyApp.Domain.Interfaces;
using MyApp.Infrastructure.Persistence;

namespace MyApp.Infrastructure.Repositories;

public class UserRepository : IUserRepository
{
    private readonly AppDbContext _db;

    public UserRepository(AppDbContext db)
    {
        _db = db;
    }

    public User? FindById(int id)
    {
        return _db.Users.FirstOrDefault(u => u.Id == id);
    }

    public User? FindByEmail(string email)
    {
        return _db.Users.FirstOrDefault(u => u.Email == email);
    }

    public IReadOnlyList<User> ListAll()
    {
        return _db.Users.ToList();
    }

    public User Add(User user)
    {
        _db.Users.Add(user);
        _db.SaveChanges();
        return user;
    }

    public void Update(User user)
    {
        _db.Users.Update(user);
        _db.SaveChanges();
    }
}
`;

const CS_ORDER_REPO_IMPL = `using MyApp.Domain.Entities;
using MyApp.Domain.Interfaces;
using MyApp.Infrastructure.Persistence;

namespace MyApp.Infrastructure.Repositories;

public class OrderRepository : IOrderRepository
{
    private readonly AppDbContext _db;

    public OrderRepository(AppDbContext db)
    {
        _db = db;
    }

    public Order? FindById(int id)
    {
        return _db.Orders.FirstOrDefault(o => o.Id == id);
    }

    public IReadOnlyList<Order> ListForUser(int userId)
    {
        return _db.Orders.Where(o => o.UserId == userId).ToList();
    }

    public Order Add(Order order)
    {
        _db.Orders.Add(order);
        _db.SaveChanges();
        return order;
    }
}
`;

const CS_PROGRAM = `using MyApp.Application.Services;
using MyApp.Domain.Interfaces;
using MyApp.Infrastructure.Persistence;
using MyApp.Infrastructure.Repositories;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

builder.Services.AddScoped<IUserRepository, UserRepository>();
builder.Services.AddScoped<IOrderRepository, OrderRepository>();
builder.Services.AddScoped<IUserService, UserService>();
builder.Services.AddScoped<IOrderService, OrderService>();

var app = builder.Build();
app.MapControllers();
app.Run();
`;

const CS_TESTS = `using MyApp.Application.Services;
using MyApp.Domain.Entities;
using MyApp.Domain.Interfaces;
using Xunit;

namespace MyApp.Tests;

public class UserServiceTests
{
    private readonly FakeUserRepository _repository = new();
    private readonly FakeHasher _hasher = new();

    [Fact]
    public void Register_CreatesUser()
    {
        var service = new UserService(_repository, _hasher, new FakeEmailSender());
        var user = service.Register("a@b.test", "secret");
        Assert.Equal("a@b.test", user.Email);
    }
}

public class FakeUserRepository : IUserRepository
{
    private readonly List<User> _users = new();

    public User? FindById(int id) => _users.FirstOrDefault(u => u.Id == id);
    public User? FindByEmail(string email) => _users.FirstOrDefault(u => u.Email == email);
    public IReadOnlyList<User> ListAll() => _users;
    public User Add(User user)
    {
        user.Id = _users.Count + 1;
        _users.Add(user);
        return user;
    }
    public void Update(User user) { }
}

public class FakeHasher : IPasswordHasher
{
    public string Hash(string password) => $"hashed:{password}";
    public bool Verify(string password, string hash) => Hash(password) == hash;
}

public class FakeEmailSender : IEmailSender
{
    public void SendWelcome(User user) { }
}
`;

const PY_SETTINGS = `"""Django settings for config."""
from pathlib import Path
import os

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-only")
DEBUG = True
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "rest_framework",
    "apps.users",
    "apps.orders",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
]

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("DB_NAME", "app"),
        "USER": os.environ.get("DB_USER", "app"),
        "PASSWORD": os.environ.get("DB_PASSWORD", "app"),
        "HOST": os.environ.get("DB_HOST", "localhost"),
        "PORT": 5432,
    }
}

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ],
}

AUTH_USER_MODEL = "users.User"

STATIC_URL = "/static/"
`;

const PY_CONFIG_URLS = `"""Root URL configuration."""
from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/users/", include("apps.users.urls")),
    path("api/orders/", include("apps.orders.urls")),
]
`;

const PY_MANAGE = `#!/usr/bin/env python
"""Django's command-line utility."""
import os
import sys


def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError("Couldn't import Django.") from exc
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
`;

const PY_USERS_MODELS = `from django.contrib.auth.models import AbstractBaseUser, BaseUserManager
from django.db import models


class UserManager(BaseUserManager):
    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError("Email is required")
        user = self.model(email=self.normalize_email(email), **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        return self.create_user(email, password, **extra_fields)


class User(AbstractBaseUser):
    email = models.EmailField(unique=True)
    display_name = models.CharField(max_length=120, blank=True)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)

    objects = UserManager()

    USERNAME_FIELD = "email"

    def __str__(self):
        return self.email

    def can_login(self):
        return self.is_active and bool(self.password)
`;

const PY_USERS_SERIALIZERS = `from django.contrib.auth import authenticate
from rest_framework import serializers

from .models import User


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "email", "display_name"]


class RegisterSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, min_length=8)

    def validate_email(self, value):
        if User.objects.filter(email=value).exists():
            raise serializers.ValidationError("Email already registered.")
        return value
`;

const PY_USERS_SERVICES = `from django.contrib.auth import authenticate

from .models import User


class UserService:
    """Business logic for user accounts."""

    def register(self, email: str, password: str) -> User:
        user = User.objects.create_user(email=email, password=password)
        self.send_welcome(user)
        return user

    def login(self, email: str, password: str) -> User:
        user = authenticate(username=email, password=password)
        if user is None:
            raise ValueError("Invalid credentials")
        return user

    def deactivate(self, user_id: int) -> None:
        User.objects.filter(id=user_id).update(is_active=False)

    def send_welcome(self, user: User) -> None:
        pass


class TokenService:
    def issue(self, user: User) -> str:
        return f"token-for-{user.pk}"

    def revoke(self, token: str) -> None:
        pass
`;

const PY_USERS_VIEWS = `from rest_framework import status
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .serializers import RegisterSerializer, UserSerializer
from .services import UserService


@api_view(["POST"])
def register(request):
    serializer = RegisterSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    service = UserService()
    user = service.register(**serializer.validated_data)
    return Response(UserSerializer(user).data, status=status.HTTP_201_CREATED)


@api_view(["GET"])
def profile(request, user_id):
    from .models import User

    user = User.objects.get(pk=user_id)
    return Response(UserSerializer(user).data)
`;

const PY_USERS_URLS = `from django.urls import path

from . import views

urlpatterns = [
    path("register/", views.register, name="register"),
    path("<int:user_id>/", views.profile, name="profile"),
]
`;

const PY_ORDERS_MODELS = `from django.db import models


class Order(models.Model):
    user_id = models.IntegerField()
    total = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    status = models.CharField(max_length=32, default="pending")
    created_at = models.DateTimeField(auto_now_add=True)

    def recalculate_total(self):
        total = sum(line.unit_price * line.quantity for line in self.lines.all())
        self.total = total
        self.save(update_fields=["total"])
        return total


class OrderLine(models.Model):
    order = models.ForeignKey(Order, related_name="lines", on_delete=models.CASCADE)
    sku = models.CharField(max_length=64)
    quantity = models.PositiveIntegerField(default=1)
    unit_price = models.DecimalField(max_digits=10, decimal_places=2)
`;

const PY_ORDERS_VIEWS = `from rest_framework.decorators import api_view
from rest_framework.response import Response

from apps.users.services import UserService
from .models import Order


@api_view(["GET"])
def revenue(request, user_id):
    total = sum(order.total for order in Order.objects.filter(user_id=user_id))
    return Response({"revenue": total})


@api_view(["POST"])
def place(request, user_id):
    user = UserService().login(request.data["email"], request.data["password"])
    order = Order.objects.create(user_id=user.pk)
    order.recalculate_total()
    return Response({"id": order.pk, "total": str(order.total)})
`;

const PY_ORDERS_SERIALIZERS = `from rest_framework import serializers

from .models import Order, OrderLine


class OrderLineSerializer(serializers.ModelSerializer):
    class Meta:
        model = OrderLine
        fields = ["sku", "quantity", "unit_price"]


class OrderSerializer(serializers.ModelSerializer):
    lines = OrderLineSerializer(many=True, read_only=True)

    class Meta:
        model = Order
        fields = ["id", "user_id", "total", "status", "lines"]
`;

const PY_ORDERS_URLS = `from django.urls import path

from . import views

urlpatterns = [
    path("<int:user_id>/revenue/", views.revenue, name="revenue"),
    path("<int:user_id>/place/", views.place, name="place"),
]
`;

const TS_CLIENT = `import type { Order, User } from '../types';

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(\`\${BASE_URL}\${path}\`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    throw new ApiError(response.status, \`Request failed: \${response.status}\`);
  }
  return response.json() as Promise<T>;
}

export class UserApiClient {
  constructor(private readonly token?: string) {}

  getUser(id: number): Promise<User> {
    return request<User>(\`/users/\${id}\`);
  }

  listOrders(userId: number): Promise<Order[]> {
    return request<Order[]>(\`/orders/\${userId}\`);
  }

  async register(email: string, password: string): Promise<User> {
    return request<User>('/users', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }
}
`;

const TS_HOOK = `import { useCallback, useEffect, useState } from 'react';
import { UserApiClient } from '../api/client';
import type { User } from '../types';

const client = new UserApiClient();

export function useUsers(userId: number) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setUser(await client.getUser(userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { user, loading, error, reload: load };
}
`;

const TS_COMPONENT = `import { useUsers } from '../hooks/useUsers';
import type { User } from '../types';

interface UserListProps {
  userId: number;
  onSelect(user: User): void;
}

export function UserList({ userId, onSelect }: UserListProps) {
  const { user, loading, error } = useUsers(userId);

  if (loading) return <div className="spinner">Loading…</div>;
  if (error) return <div className="error">{error}</div>;
  if (!user) return null;

  return (
    <ul className="user-list">
      <li onClick={() => onSelect(user)}>
        <span className="name">{user.displayName}</span>
        <span className="email">{user.email}</span>
      </li>
    </ul>
  );
}
`;

const TS_APP = `import { useState } from 'react';
import { UserList } from './components/UserList';
import type { User } from './types';

export function App() {
  const [selected, setSelected] = useState<User | null>(null);

  return (
    <main className="app">
      <h1>MyApp</h1>
      <UserList userId={1} onSelect={setSelected} />
      {selected && <aside className="detail">{selected.displayName}</aside>}
    </main>
  );
}
`;

const TS_TYPES = `export interface User {
  id: number;
  email: string;
  displayName: string;
}

export interface Order {
  id: number;
  userId: number;
  total: number;
  status: string;
}
`;

const TS_MAIN = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

const files: Record<string, string> = {
  // ---- .NET solution ----------------------------------------------------
  'dotnet/MyApp.sln': `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "MyApp.Api", "src\\MyApp.Api\\MyApp.Api.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
Global
EndGlobal
`,
  'dotnet/Directory.Build.props': `<Project>
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
`,
  'dotnet/.gitignore': `bin/\nobj/\n*.user\n`,
  'dotnet/src/MyApp.Api/MyApp.Api.csproj': `<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" />
  </ItemGroup>
</Project>
`,
  'dotnet/src/MyApp.Api/Program.cs': CS_PROGRAM,
  'dotnet/src/MyApp.Api/Controllers/UsersController.cs': CS_USERS_CONTROLLER,
  'dotnet/src/MyApp.Api/Controllers/OrdersController.cs': CS_ORDERS_CONTROLLER,
  'dotnet/src/MyApp.Api/obj/project.assets.json': '{"version": 3, "targets": {}}',
  'dotnet/src/MyApp.Api/obj/Debug/net8.0/MyApp.Api.AssemblyInfo.cs': '// generated file, must be ignored\n',
  'dotnet/src/MyApp.Api/bin/Debug/net8.0/MyApp.Api.dll': 'BINARY-NOT-REAL',
  'dotnet/src/MyApp.Domain/MyApp.Domain.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  'dotnet/src/MyApp.Domain/Entities/User.cs': CS_USER,
  'dotnet/src/MyApp.Domain/Entities/Order.cs': CS_ORDER,
  'dotnet/src/MyApp.Domain/Interfaces/IUserRepository.cs': CS_IUSER_REPO,
  'dotnet/src/MyApp.Domain/Interfaces/IOrderRepository.cs': CS_IORDER_REPO,
  'dotnet/src/MyApp.Application/MyApp.Application.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  'dotnet/src/MyApp.Application/Services/UserService.cs': CS_USER_SERVICE,
  'dotnet/src/MyApp.Application/Services/OrderService.cs': CS_ORDER_SERVICE,
  'dotnet/src/MyApp.Infrastructure/MyApp.Infrastructure.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  'dotnet/src/MyApp.Infrastructure/Persistence/AppDbContext.cs': CS_DBCONTEXT,
  'dotnet/src/MyApp.Infrastructure/Repositories/UserRepository.cs': CS_USER_REPO_IMPL,
  'dotnet/src/MyApp.Infrastructure/Repositories/OrderRepository.cs': CS_ORDER_REPO_IMPL,
  'dotnet/tests/MyApp.Tests/MyApp.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  'dotnet/tests/MyApp.Tests/UserServiceTests.cs': CS_TESTS,

  // ---- Django project ---------------------------------------------------
  'django/manage.py': PY_MANAGE,
  'django/requirements.txt': 'Django==5.0.6\ndjangorestframework==3.15.1\npsycopg2-binary==2.9.9\n',
  'django/config/__init__.py': '',
  'django/config/settings.py': PY_SETTINGS,
  'django/config/urls.py': PY_CONFIG_URLS,
  'django/apps/__init__.py': '',
  'django/apps/users/__init__.py': '',
  'django/apps/users/models.py': PY_USERS_MODELS,
  'django/apps/users/serializers.py': PY_USERS_SERIALIZERS,
  'django/apps/users/services.py': PY_USERS_SERVICES,
  'django/apps/users/views.py': PY_USERS_VIEWS,
  'django/apps/users/urls.py': PY_USERS_URLS,
  'django/apps/users/admin.py': 'from django.contrib import admin\n\nfrom .models import User\n\nadmin.site.register(User)\n',
  'django/apps/orders/__init__.py': '',
  'django/apps/orders/models.py': PY_ORDERS_MODELS,
  'django/apps/orders/serializers.py': PY_ORDERS_SERIALIZERS,
  'django/apps/orders/views.py': PY_ORDERS_VIEWS,
  'django/apps/orders/urls.py': PY_ORDERS_URLS,
  'django/templates/base.html': '<!doctype html>\n<html><body>{% block content %}{% endblock %}</body></html>\n',
  'django/static/css/site.css': '.app { color: #333; }\n',
  'django/venv/lib/python3.12/site-packages/django/__init__.py': 'VERSION = (5, 0, 6)\n',

  // ---- full stack monorepo ---------------------------------------------
  'fullstack/backend/MyApp.Api/MyApp.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n',
  'fullstack/backend/MyApp.Api/Program.cs': CS_PROGRAM,
  'fullstack/backend/MyApp.Api/Controllers/UsersController.cs': CS_USERS_CONTROLLER,
  'fullstack/backend/MyApp.Api/Controllers/OrdersController.cs': CS_ORDERS_CONTROLLER,
  'fullstack/backend/MyApp.Api/obj/Debug/net8.0/generated.g.cs': '// ignored\n',
  'fullstack/backend/MyApp.Domain/MyApp.Domain.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  'fullstack/backend/MyApp.Domain/Entities/User.cs': CS_USER,
  'fullstack/backend/MyApp.Domain/Entities/Order.cs': CS_ORDER,
  'fullstack/backend/MyApp.Domain/Interfaces/IUserRepository.cs': CS_IUSER_REPO,
  'fullstack/backend/MyApp.Application/MyApp.Application.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  'fullstack/backend/MyApp.Application/Services/UserService.cs': CS_USER_SERVICE,
  'fullstack/backend/MyApp.Application/Services/OrderService.cs': CS_ORDER_SERVICE,
  'fullstack/backend/MyApp.Infrastructure/MyApp.Infrastructure.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  'fullstack/backend/MyApp.Infrastructure/Persistence/AppDbContext.cs': CS_DBCONTEXT,
  'fullstack/backend/MyApp.Infrastructure/Repositories/UserRepository.cs': CS_USER_REPO_IMPL,
  'fullstack/backend/MyApp.Infrastructure/Repositories/OrderRepository.cs': CS_ORDER_REPO_IMPL,
  'fullstack/frontend/package.json': '{"name": "frontend", "dependencies": {"react": "^18.3.1"}}\n',
  'fullstack/frontend/tsconfig.json': '{"compilerOptions": {"strict": true}}\n',
  'fullstack/frontend/vite.config.ts': "import { defineConfig } from 'vite';\nexport default defineConfig({});\n",
  'fullstack/frontend/src/main.tsx': TS_MAIN,
  'fullstack/frontend/src/App.tsx': TS_APP,
  'fullstack/frontend/src/types.ts': TS_TYPES,
  'fullstack/frontend/src/api/client.ts': TS_CLIENT,
  'fullstack/frontend/src/hooks/useUsers.ts': TS_HOOK,
  'fullstack/frontend/src/components/UserList.tsx': TS_COMPONENT,
  'fullstack/frontend/src/index.css': '.app { font-family: sans-serif; }\n',
  'fullstack/frontend/node_modules/react/index.js': 'module.exports = {};\n',
  'fullstack/frontend/node_modules/.bin/vite': '#!/usr/bin/env node\n',
  'fullstack/README.md': '# MyApp\n\nMonorepo with a .NET backend and a React frontend.\n',

  // ---- marker-less multi-folder repository ------------------------------
  // No build files anywhere: the structural level has to fall back to the
  // top-level folders that are not layer names (client/ and server/), so a
  // two-sided project still reads as two sides instead of one pile of layers.
  'markerless/server/main.ts': `export class Server {\n  private port = 8080;\n  start(): string { return 'listening on ' + this.port; }\n}\n`,
  // The client deliberately depends on a server type, so the fixture also
  // exercises a relationship that crosses two structural scopes.
  'markerless/client/app.ts': `import { Logger } from '../server/util/logger';\nexport interface ViewState { ready: boolean; }\nexport class App {\n  private state: ViewState;\n  private logger: Logger;\n  constructor(logger: Logger) { this.logger = logger; this.state = { ready: false }; }\n  makeLogger(): Logger { return this.logger; }\n  render(): string { this.logger.log('render'); return this.state.ready ? 'ready' : 'loading'; }\n}\n`,
  'markerless/server/util/logger.ts': `export class Logger {\n  log(message: string): void { void message; }\n}\n`,
};

const outDir = process.argv[2] ?? '/tmp/xray-fixtures';
for (const [relative, content] of Object.entries(files)) {
  const full = join(outDir, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}
console.log(`wrote ${Object.keys(files).length} files to ${outDir}`);
console.log('fixtures:', ['dotnet', 'django', 'fullstack', 'markerless'].join(', '));
