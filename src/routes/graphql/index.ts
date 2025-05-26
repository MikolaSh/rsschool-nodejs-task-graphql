import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { createGqlResponseSchema, gqlResponseSchema } from './schemas.js';
import { graphql, GraphQLBoolean, GraphQLEnumType, GraphQLFloat, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLResolveInfo, GraphQLSchema, GraphQLString, validate } from 'graphql';
import { MemberType, Post, Profile, User } from '@prisma/client';
import { MemberTypeId } from '../member-types/schemas.js';
import DataLoader from 'dataloader';
import { UUIDType } from './types/uuid.js';
import { parseResolveInfo, ResolveTree } from 'graphql-parse-resolve-info';

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  const { prisma } = fastify;

  const createLoader = <
    T extends { id?: string; memberTypeId?: string | MemberTypeId },
    K extends string | MemberTypeId
  >(
    batchFn: (keys: readonly K[]) => Promise<T[]>
  ) => {
    return new DataLoader<K, T>(async (keys) => {
      const results = await batchFn(keys);
      return keys.map((key) => {
        const result = results.find((result) => {
          if (result.id !== undefined && typeof key === 'string') {
            return result.id === key;
          }
          if (result.memberTypeId !== undefined && typeof key !== 'string') {
            return result.memberTypeId === key;
          }
          return false;
        }); 

        if (!result) {
          return new Error(`No result for ${key}`);
        }
        return result;
      });
    });
  };

  const memberTypeLoader = createLoader<MemberType, MemberTypeId>(async (ids) => {
    const result = await prisma.memberType.findMany({
      where: { id: { in: [...ids] } },
    });
    return result;
  });

  const postLoader = createLoader<Post, string>(async (ids) => {
    return prisma.post.findMany({
      where: { id: { in: [...ids] } },
    });
  });

  const profileLoader = createLoader<Profile & { memberTypeId: MemberTypeId }, string>(
    async (ids) => {
      const profiles = await prisma.profile.findMany({
        where: { id: { in: [...ids] } },
      });
      return profiles as (Profile & { memberTypeId: MemberTypeId })[];
    }
  );

  const userLoader = new DataLoader<string, User>(async (ids: readonly string[]) => {
    const users = await prisma.user.findMany({
      where: { id: { in: [...ids] } }, // Преобразуем readonly в обычный массив
      include: {
        userSubscribedTo: true,
        subscribedToUser: true,
      },
    });
    
    return ids.map(id => {
      const user = users.find(u => u.id === id);
      return user || new Error(`User not found: ${id}`);
    });
  });

  const MemberTypeIdGQL = new GraphQLEnumType({
    name: "MemberTypeId",
    values: {
      BASIC: {value: "BASIC"},
      BUSINESS: {value: "BUSINESS"}
    },
  });

  const MemberTypeGQL = new GraphQLObjectType({
    name: "MemberType",
    fields: () => ({
      id: { type: MemberTypeIdGQL },
      discount: { type: new GraphQLNonNull(GraphQLFloat) },
      postsLimitPerMonth: { type: new GraphQLNonNull(GraphQLInt) }
    })
  });

  const PostGQL = new GraphQLObjectType({
    name: 'Post',
    fields: () => ({
      id: { type: new GraphQLNonNull(UUIDType) },
      title: { type: new GraphQLNonNull(GraphQLString) },
      content: { type: new GraphQLNonNull(GraphQLString) },
    }),
  });

  const ProfileGQL = new GraphQLObjectType({
    name: "Profile",
    fields: () => ({
      id: { type: new GraphQLNonNull(UUIDType)},
      isMale: { type: new GraphQLNonNull(GraphQLBoolean)},
      yearOfBirth: { type: new GraphQLNonNull(GraphQLInt)},
      memberType: { type: new GraphQLNonNull(MemberTypeGQL), resolve: (source: {memberTypeId: MemberTypeId}) => memberTypeLoader.load(source.memberTypeId)}
    })
  });

  const UserGQL = new GraphQLObjectType({
    name: "User",
    fields: () => ({
      id: {type: new GraphQLNonNull(UUIDType)},
      name: {type: new GraphQLNonNull(GraphQLString)},
      balance: {type: new GraphQLNonNull(GraphQLFloat)},
      profile: {
        type: ProfileGQL,
        resolve: async (source: User, _args: object, _context: unknown, info: GraphQLResolveInfo): Promise<Profile | null> => {
          const parsedInfo = parseResolveInfo(info) as ResolveTree | null;
          
          if (parsedInfo?.fieldsByTypeName.Profile) {
            return prisma.profile.findUnique({ 
              where: { userId: source.id } 
            });
          }
          return null;
        },
      },
      posts: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PostGQL))),
        resolve: (source) => prisma.post.findMany({ where: { authorId: source.id } }),
      },
      userSubscribedTo: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(UserGQL))),
        resolve: async (source: User & { userSubscribedTo?: User[] }): Promise<User[]> => {
          if ('userSubscribedTo' in source && source.userSubscribedTo) {
            return source.userSubscribedTo;
          }
          return prisma.user.findMany({
            where: { 
              subscribedToUser: { 
                some: { subscriberId: source.id } 
              } 
            },
          });
        },
      },
      subscribedToUser: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(UserGQL))),
        resolve: async (source: User & { subscribedToUser?: User[] }): Promise<User[]> => {
          if ('subscribedToUser' in source && source.subscribedToUser) {
            return source.subscribedToUser;
          }
          return prisma.user.findMany({
            where: { 
              userSubscribedTo: { 
                some: { authorId: source.id } 
              } 
            },
          });
        },
      }
    }),
  });

  const RootQueryType = new GraphQLObjectType({
    name: 'RootQuery',
    fields: {
      memberTypes: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(MemberTypeGQL))),
        resolve: () => prisma.memberType.findMany(),
      },
      memberType: {
        type: MemberTypeGQL,
        args: { id: { type: new GraphQLNonNull(MemberTypeIdGQL) } },
        resolve: (_: unknown, args: { id: MemberTypeId }) => memberTypeLoader.load(args.id),
      },
      posts: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PostGQL))),
        resolve: () => prisma.post.findMany(),
      },
      post: {
        type: PostGQL,
        args: { id: { type: new GraphQLNonNull(UUIDType) } },
        resolve: (_, args: {id: string }) => postLoader.load(args.id),
      },
      profiles: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ProfileGQL))),
        resolve: () => prisma.profile.findMany(),
      },
      profile: {
        type: ProfileGQL,
        args: { id: { type: new GraphQLNonNull(UUIDType) } },
        resolve: (_, args: { id: string }) => profileLoader.load(args.id),
      },
      users: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(UserGQL))),
        resolve: () => prisma.user.findMany({
          include: {
            userSubscribedTo: true,
            subscribedToUser: true,
          },
        }),
      },
      user: {
        type: UserGQL as GraphQLObjectType,
        args: { id: { type: new GraphQLNonNull(UUIDType) } },
        resolve: (
          _parent: unknown,
          args: { id: string }, // Явная типизация аргументов
          _context: unknown,
          _info: GraphQLResolveInfo
        ): Promise<User> => {
          return userLoader.load(args.id); // Теперь безопасно
        },
      }
    }
  });

  const schema = new GraphQLSchema({
    query: RootQueryType,
  });

  fastify.route({
    url: '/',
    method: 'POST',
    schema: {
      ...createGqlResponseSchema,
      response: {
        200: gqlResponseSchema,
      },
    },
    async handler(req) {
      return graphql({
        schema,
        source: req.body.query,
        contextValue: { prisma, loaders: { memberTypeLoader } },
      });
    },
  });
};

export default plugin;
