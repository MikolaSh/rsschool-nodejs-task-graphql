import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { createGqlResponseSchema, gqlResponseSchema } from './schemas.js';
import { graphql, GraphQLBoolean, GraphQLEnumType, GraphQLFloat, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLResolveInfo, GraphQLSchema, GraphQLString, validate } from 'graphql';
import { MemberType, Post, Profile, User } from '@prisma/client';
import { MemberTypeId } from '../member-types/schemas.js';
import DataLoader from 'dataloader';
import { UUIDType } from './types/uuid.js';
import { parseResolveInfo, ResolveTree } from 'graphql-parse-resolve-info';

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  const { prisma } = fastify;

  const createLoader = <
    T extends { id?: string; memberTypeId?: string | MemberTypeId } | null,
    K extends string | MemberTypeId
  >(
    batchFn: (keys: readonly K[]) => Promise<(T | null)[]>
  ) => {
    return new DataLoader<K, T | null>(async (keys) => {
      const results = await batchFn(keys);
      return keys.map((key) => {
        const result = results.find((result) => {
          if (!result) return false;
          if (result.id !== undefined && typeof key === 'string') {
            return result.id === key;
          }
          if (result.memberTypeId !== undefined && typeof key !== 'string') {
            return result.memberTypeId === key;
          }
          return false;
        });
        return result || null;
      });
    });
  };

  const memberTypeLoader = createLoader<MemberType, MemberTypeId>(async (ids) => {
    const result = await prisma.memberType.findMany({
      where: { id: { in: ids as MemberTypeId[] } },
    });
    return result;
  });

  const postLoader = createLoader<Post | null, string>(async (ids) => {
    const posts = await prisma.post.findMany({
      where: { id: { in: [...ids] } },
    });
    return ids.map(id => posts.find(post => post.id === id) || null);
  });

  const profileLoader = createLoader<Profile & { memberTypeId: MemberTypeId }, string>(
    async (ids) => {
      const profiles = await prisma.profile.findMany({
        where: { id: { in: [...ids] } },
      });
      return profiles as (Profile & { memberTypeId: MemberTypeId })[];
    }
  );

  const userLoader = new DataLoader<string, User | null>(async (ids) => {
    const users = await prisma.user.findMany({
      where: { id: { in: [...ids] } },
      include: {
        userSubscribedTo: {
          include: {
            author: true
          }
        },
        subscribedToUser: {
          include: {
            subscriber: true
          }
        },
      },
    });
    
    return ids.map(id => {
      const user = users.find(u => u.id === id);
      if (!user) return null;
      
      return {
        ...user,
        userSubscribedTo: user.userSubscribedTo?.map(sub => sub.author) || [],
        subscribedToUser: user.subscribedToUser?.map(sub => sub.subscriber) || []
      };
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
        resolve: (source: User & { userSubscribedTo?: User[] }) => {
          if (source.userSubscribedTo) {
            return source.userSubscribedTo;
          }
          return prisma.user.findMany({
            where: { 
              subscribedToUser: { 
                some: { subscriberId: source.id } 
              } 
            },
            include: {
              userSubscribedTo: true,
              subscribedToUser: true,
            },
          });
        },
      },
      subscribedToUser: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(UserGQL))),
        resolve: (source: User & { subscribedToUser?: User[] }) => {
          if (source.subscribedToUser) {
            return source.subscribedToUser;
          }
          return prisma.user.findMany({
            where: { 
              userSubscribedTo: { 
                some: { authorId: source.id } 
              } 
            },
            include: {
              userSubscribedTo: true,
              subscribedToUser: true,
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
        resolve: (_, args: { id: string }) => userLoader.load(args.id),
      },
    }
  });

  const CreateUserInput = new GraphQLInputObjectType({
    name: "CreateUserInput",
    fields: () => ({
      name: { type: new GraphQLNonNull(GraphQLString) },
      balance: { type: new GraphQLNonNull(GraphQLFloat) },
    })
  });

  const ChangeUserInput = new GraphQLInputObjectType({
    name: 'ChangeUserInput',
    fields: () => ({
      name: { type: GraphQLString },
      balance: { type: GraphQLFloat },
    }),
  });

  const CreateProfileInput = new GraphQLInputObjectType({
    name: "CreateProfileInput",
    fields: () => ({
      isMale: { type: new GraphQLNonNull(GraphQLBoolean) },
      yearOfBirth: { type: new GraphQLNonNull(GraphQLInt) },
      userId: { type: new GraphQLNonNull(UUIDType) },
      memberTypeId: { type: new GraphQLNonNull(MemberTypeIdGQL) },
    })
  });

  const ChangeProfileInput = new GraphQLInputObjectType({
    name: 'ChangeProfileInput',
    fields: () => ({
      isMale: { type: GraphQLBoolean },
      yearOfBirth: { type: GraphQLInt },
      memberTypeId: { type: MemberTypeIdGQL },
    }),
  });

  const CreatePostInput = new GraphQLInputObjectType({
    name: 'CreatePostInput',
    fields: () => ({
      title: { type: new GraphQLNonNull(GraphQLString) },
      content: { type: new GraphQLNonNull(GraphQLString) },
      authorId: { type: new GraphQLNonNull(UUIDType) },
    }),
  });
  
  const ChangePostInput = new GraphQLInputObjectType({
    name: 'ChangePostInput',
    fields: () => ({
      title: { type: GraphQLString },
      content: { type: GraphQLString },
    }),
  });

  const Mutation = new GraphQLObjectType({
    name: "Mutation",
    fields: {
      createUser: {
        type: new GraphQLNonNull(UserGQL),
        args: {
          dto: { type: new GraphQLNonNull(CreateUserInput) },
        },
        resolve: (_, args: { dto: { name: string; balance: number } }) => {
          return prisma.user.create({
            data: args.dto,
          });
        },
      },
      changeUser: {
        type: new GraphQLNonNull(UserGQL),
        args: {
          id: { type: new GraphQLNonNull(UUIDType) },
          dto: { type: new GraphQLNonNull(ChangeUserInput) },
        },
        resolve: (_, args: { id: string; dto: { name?: string; balance?: number } }) => {
          return prisma.user.update({
            where: { id: args.id },
            data: args.dto,
          });
        },
      },
      deleteUser: {
        type: new GraphQLNonNull(GraphQLString),
        args: {
          id: { type: new GraphQLNonNull(UUIDType) },
        },
        resolve: (_, args: { id: string }) => {
          return prisma.user.delete({ 
            where: { id: args.id } 
          }).then(() => 'ok');
        },
      },
      createProfile: {
        type: new GraphQLNonNull(ProfileGQL),
        args: {
          dto: { type: new GraphQLNonNull(CreateProfileInput) },
        },
        resolve: async (
          _: unknown, 
          args: { 
            dto: { 
              isMale: boolean; 
              yearOfBirth: number; 
              userId: string; 
              memberTypeId: string 
            } 
          }
        ) => {
          return prisma.profile.create({
            data: {
              isMale: args.dto.isMale,
              yearOfBirth: args.dto.yearOfBirth,
              userId: args.dto.userId,
              memberTypeId: args.dto.memberTypeId as MemberTypeId,
            },
          });
        },
      },
      changeProfile: {
        type: new GraphQLNonNull(ProfileGQL),
        args: {
          id: { type: new GraphQLNonNull(UUIDType) },
          dto: { type: new GraphQLNonNull(ChangeProfileInput) },
        },
        resolve: async (
          _: unknown,
          args: {
            id: string;
            dto: {
              isMale?: boolean;
              yearOfBirth?: number;
              memberTypeId?: string;
            }
          }
        ) => {
          return prisma.profile.update({
            where: { id: args.id },
            data: {
              ...(args.dto.isMale !== undefined && { isMale: args.dto.isMale }),
              ...(args.dto.yearOfBirth !== undefined && { 
                yearOfBirth: args.dto.yearOfBirth 
              }),
              ...(args.dto.memberTypeId !== undefined && {
                memberTypeId: args.dto.memberTypeId as MemberTypeId
              }),
            },
          });
        },
      },
      deleteProfile: {
        type: new GraphQLNonNull(GraphQLString),
        args: {
          id: { type: new GraphQLNonNull(UUIDType) },
        },
        resolve: async (
          _: unknown,
          args: { id: string }
        ) => {
          await prisma.profile.delete({
            where: { id: args.id },
          });
          return 'ok';
        },
      },
      createPost: {
        type: new GraphQLNonNull(PostGQL),
        args: {
          dto: { type: new GraphQLNonNull(CreatePostInput) },
        },
        resolve: async (
          _: unknown,
          args: { 
            dto: { 
              title: string; 
              content: string; 
              authorId: string 
            } 
          }
        ) => {
          return prisma.post.create({
            data: {
              title: args.dto.title,
              content: args.dto.content,
              authorId: args.dto.authorId
            },
          });
        },
      },
      
      changePost: {
        type: new GraphQLNonNull(PostGQL),
        args: {
          id: { type: new GraphQLNonNull(UUIDType) },
          dto: { type: new GraphQLNonNull(ChangePostInput) },
        },
        resolve: async (
          _: unknown,
          args: { 
            id: string; 
            dto: { 
              title?: string; 
              content?: string 
            } 
          }
        ) => {
          return prisma.post.update({
            where: { id: args.id },
            data: {
              ...(args.dto.title !== undefined && { title: args.dto.title }),
              ...(args.dto.content !== undefined && { content: args.dto.content }),
            },
          });
        },
      },
      
      deletePost: {
        type: new GraphQLNonNull(GraphQLString),
        args: {
          id: { type: new GraphQLNonNull(UUIDType) },
        },
        resolve: async (
          _: unknown,
          args: { id: string }
        ) => {
          await prisma.post.delete({ 
            where: { id: args.id } 
          });
          return 'ok';
        },
      }
    }
  })

  const schema = new GraphQLSchema({
    query: RootQueryType,
    mutation: Mutation,
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
        variableValues: req.body.variables,
        contextValue: { prisma, loaders: { memberTypeLoader, userLoader, postLoader, profileLoader } },
      });
    },
  });
};

export default plugin;
