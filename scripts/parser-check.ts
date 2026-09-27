// Dev utility: prints what the C# parser extracted for a snippet.
// Run with:  node --experimental-strip-types scripts/parser-check.ts   (Node 22+)
// or bundle it:  npx esbuild scripts/parser-check.ts --bundle --platform=node --format=esm --outfile=/tmp/x.js && node /tmp/x.js

import { parseCSharp } from '../src/core/parser/csharp/parser.ts';
import { parseTypeScript } from '../src/core/parser/tsjs/parser.ts';
import { parsePython } from '../src/core/parser/python/parser.ts';

const SNIPPETS: Array<{ name: string; source: string }> = [
  {
    name: 'interface with 4 methods',
    source: `
namespace Sample.Services;

public interface IUserService
{
    User GetUser(int id);
    User Register(LoginRequest request);
    void UpdateProfile(int id, string displayName);
    IReadOnlyList<User> Search(string query);
}
`,
  },
  {
    name: 'class with fields, props and methods',
    source: `
namespace Sample.Services;

public class UserService : IUserService
{
    private readonly IUserRepository _users;
    private readonly List<User> _cache = new();

    public string Name { get; set; }

    public UserService(IUserRepository users)
    {
        _users = users;
    }

    public User GetUser(int id)
    {
        var user = _users.FindById(id);
        return user;
    }
}
`,
  },
];

for (const snippet of SNIPPETS) {
  const result = parseCSharp('test/file.cs', snippet.source);
  console.log(`\n=== ${snippet.name} ===`);
  console.log('types:', result.types.map((t) => `${t.kind} ${t.name} (base: ${t.baseNames.join(',') || 'none'})`));
  console.log('members:', result.members.map((m) => `${m.kind} ${m.ownerId.split('.').pop()} ${m.name} :: ${m.signature}`));
  const duplicates = result.members
    .map((m) => m.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  console.log('duplicate member ids:', duplicates.length);
  console.log('relations:', result.relations.map((r) => `${r.kind} -> ${r.toName}${r.methodName ? `.${r.methodName}` : ''}`));
}

const TS_SNIPPET = `
import { UserRepository } from './repositories/UserRepository';
import type { User } from '../models/User';

export interface UserService {
  getUser(id: number): Promise<User>;
  register(email: string): Promise<User>;
}

export class HttpUserService implements UserService {
  private readonly repo: UserRepository;
  public baseUrl: string = '/api';

  constructor(repo: UserRepository) {
    this.repo = repo;
  }

  async getUser(id: number): Promise<User> {
    return this.repo.findById(id);
  }
}

export const createUserService = (repo: UserRepository): UserService => {
  return new HttpUserService(repo);
};
`;

const PY_SNIPPET = `
from django.contrib.auth import authenticate
from rest_framework import serializers

from .models import User


class UserSerializer(serializers.ModelSerializer):
    """Serializer for :class:\`User\`."""

    class Meta:
        model = User
        fields = ["id", "email"]

    email = serializers.EmailField()

    def validate_email(self, value: str) -> str:
        if User.objects.filter(email=value).exists():
            raise serializers.ValidationError("taken")
        return value


def register(request, user_id: int):
    """A module level view function."""
    serializer = UserSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    user = User.objects.create_user(email="a@b.test")
    return {'id': user.pk}
`;

const pyResult = parsePython('apps/users/serializers.py', PY_SNIPPET);
console.log('\n=== python ===');
console.log('imports:', pyResult.imports);
console.log('types:', pyResult.types.map((t) => `${t.kind} ${t.name} (base: ${t.baseNames.join(',') || 'none'})`));
console.log('members:', pyResult.members.map((m) => `${m.kind} ${m.name} :: ${m.signature}`));
console.log('relations:', pyResult.relations.map((r) => `${r.kind} -> ${r.toName}${r.methodName ? `.${r.methodName}` : ''}`));

const tsResult = parseTypeScript('client/services/UserService.ts', TS_SNIPPET);
console.log('\n=== typescript ===');
console.log('imports:', tsResult.imports);
console.log('types:', tsResult.types.map((t) => `${t.kind} ${t.name} (base: ${t.baseNames.join(',') || 'none'})`));
console.log('members:', tsResult.members.map((m) => `${m.kind} ${m.name}`));
console.log('relations:', tsResult.relations.map((r) => `${r.kind} -> ${r.toName}${r.methodName ? `.${r.methodName}` : ''}`));

