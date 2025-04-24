import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  ToolMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { Annotation, Command, END, interrupt, START, StateGraph } from '@langchain/langgraph';
import { BaseLanguageModel } from '@langchain/core/language_models/base';
import { MessagesPlaceholder } from '@langchain/core/prompts';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { AgentState, createReactAgent, ToolNode } from '@langchain/langgraph/prebuilt';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { shouldBindTools } from '../utils/llm';
import { DynamicStructuredTool, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { AskTool } from '../tools/AskTool';
import { BaseAgent } from '../../BaseAgent';
import { PlanningAgent } from '../PlanningAgent';
import { set } from 'lodash';

const createToolCallId = () => {
  // random 5 characters
  return Math.random().toString(36).substring(2, 8);
};

const StateAnnotation = Annotation.Root({
  executor_response_tools: Annotation<ToolMessage[]>,
  executor_input: Annotation<string>,
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
  plans: Annotation<
    {
      title: string;
      tasks: { title: string; status: string; retry?: number; result?: string; index: number }[];
      plan_id: string;
      status: string;
    }[]
  >,
  active_plan_id: Annotation<string>,
  selected_task_indexes: Annotation<number[]>,
  next_node: Annotation<string>,
  ended_by: Annotation<string>,
  reject_transaction: Annotation<boolean>,
  answer: Annotation<string>,
  thread_id: Annotation<string>,
  interrupted_request: Annotation<string>,
});

export class ExecutorGraph {
  private model: BaseLanguageModel;
  private executorPrompt: string;
  private tools: DynamicStructuredTool[];
  private agent: PlanningAgent;
  private _processedThreads: Set<string> = new Set();

  private logToolExecution(
    toolName: string,
    state: 'started' | 'in_progress' | 'completed' | 'failed',
    data?: any,
  ) {
    const timestamp = new Date().toISOString();
    const emoji = {
      started: '🚀',
      in_progress: '⏳',
      completed: '✅',
      failed: '❌',
    }[state];

    console.log(`[${timestamp}] ${emoji} Tool ${toolName} execution ${state}`);
    console.log(`Result:`, JSON.stringify(data, null, 2));
  }

  constructor({
    model,
    executorPrompt,
    tools,
    agent,
  }: {
    model: BaseLanguageModel;
    executorPrompt: string;
    tools: DynamicStructuredTool[];
    agent: PlanningAgent;
  }) {
    this.model = model;
    this.executorPrompt = executorPrompt;
    this.tools = tools;
    this.agent = agent;
  }

  routeAfterAgent(state: typeof StateAnnotation.State) {
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;

    // If no tools are called, we can finish (respond to the user)
    if (!lastMessage?.tool_calls?.length) {
      return 'end';
    }

    if (state.thread_id && !this._processedThreads.has(state.thread_id)) {
      return 'executor_terminate';
    }

    if (lastMessage?.tool_calls?.length && lastMessage?.tool_calls[0]?.name === 'terminate') {
      return 'executor_terminate';
    }

    if (lastMessage?.tool_calls?.length && lastMessage?.tool_calls[0]?.name === 'ask_user') {
      return 'ask_user';
    }

    if (lastMessage?.tool_calls?.length && this.agent.config.isHumanReview) {
      for (const toolCall of lastMessage?.tool_calls) {
        const tool = this.agent.getRegisteredTools().find(t => t.getName() === toolCall?.name);
        if ((tool as any)?.simulateQuoteTool) {
          return 'review_transaction';
        }
      }
    }
    // Otherwise if there are tool calls, we continue to execute them
    return 'executor_tools';
  }

  async executorAgentNode(state: typeof StateAnnotation.State) {
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', this.executorPrompt],
      ['human', '{input}'],
      new MessagesPlaceholder('messages'),
    ]);

    // Check if there are any messages in the state to determine if we need to call the terminate tool with a reason or not
    const terminateTool =
      state.messages?.length > 0
        ? tool(
            async (input: {}) => {
              return 'finished';
            },
            {
              name: 'terminate',
              description: 'Call you want to finish the task',
              schema: z.object({}),
            },
          )
        : tool(
            async (input: {}) => {
              return 'finished';
            },
            {
              name: 'terminate',
              description: 'Call you want to finish the task',
              schema: z.object({
                reason: z.string().optional().describe('Reason for calling terminate tool'),
              }),
            },
          );

    const askTool = new AskTool();
    const wrappedAskTool = this.agent.addTool2CallbackManager(askTool);

    if (state.thread_id && !this._processedThreads.has(state.thread_id)) {
      this._processedThreads.add(state.thread_id);
    }

    let modelWithTools;
    if (shouldBindTools(this.model, this.tools)) {
      if (!('bindTools' in this.model) || typeof this.model.bindTools !== 'function') {
        throw new Error(`llm ${this.model} must define bindTools method.`);
      }
      modelWithTools = this.model.bind({
        tools: [...this.tools, terminateTool, wrappedAskTool].map(t => convertToOpenAITool(t)),
        tool_choice: 'required',
      } as any);
    } else {
      modelWithTools = this.model;
    }

    const agent = prompt.pipe(modelWithTools);

    const responseMessage = await agent.invoke({
      input: state.executor_input,
      messages: [...(state.messages ?? [])],
    });

    if (responseMessage.tool_calls?.length) {
      //filter tool calls only ask_user
      let askUserToolCalls = responseMessage.tool_calls.filter(
        (toolCall: any) => toolCall.name === 'ask_user',
      );
      if (askUserToolCalls?.length > 1) {
        let index = 0;
        const askUserToolCallsString = askUserToolCalls.reduce((acc: any, toolCall: any) => {
          if (index === 0) {
            return `${++index}. ${toolCall.args.question}`;
          }
          return acc + `\n${++index}. ${toolCall.args.question}`;
        }, '');
        return {
          messages: [
            new AIMessage({
              content: '',
              tool_calls: [
                {
                  id: askUserToolCalls[0].id,
                  name: 'ask_user',
                  args: { question: askUserToolCallsString },
                },
              ],
            }),
          ],
        };
      }
    }

    return { messages: [responseMessage] };
  }

  getExecutorResponseTools(messages: BaseMessage[]) {
    const responseTools = messages
      ?.filter((m: BaseMessage) => m.constructor.name == 'ToolMessage')
      .map((item: BaseMessage) => {
        const toolMessage = item as ToolMessage;
        if (toolMessage.name === 'ask_user') {
          const askUserMessage = messages.find((m: any) => {
            return m.tool_calls?.[0]?.id === toolMessage.tool_call_id;
          }) as AIMessage;
          if (askUserMessage) {
            return {
              ...item,
              tool_call_id: createToolCallId(),
              content:
                'You asked user: ' +
                askUserMessage?.tool_calls?.[0]?.args?.question +
                '\nUser response: ' +
                item.content,
            };
          }
        }
        return { ...item, tool_call_id: createToolCallId() };
      });
    return responseTools;
  }

  async executorTerminateNode(state: typeof StateAnnotation.State) {
    if (state.reject_transaction) {
      if (state.ended_by === 'other_action') {
        return {
          next_node: END,
          ended_by: state.ended_by,
        };
      } else {
        const prompt = ChatPromptTemplate.fromMessages([
          [
            'system',
            `The user has rejected the transaction. 
            Inform them that the previous plan and its execution have been deleted. 
            Let them know that their next input will create a new plan. 
            Provide a helpful response and short enough to be understood by the user.`,
          ],
          ['human', `reason terminated: {reason}`],
          ['human', 'terminated plans: {plans}'],
        ]);

        const reason = state.messages[state.messages.length - 1]?.content ?? '';

        const response = await prompt
          .pipe(
            this.model.withConfig({
              tags: ['final_node'],
            }),
          )
          .invoke({
            reason: reason,
            plans: JSON.stringify(state.plans),
          });

        return {
          chat_history: [response],
          answer: response.content,
          next_node: END,
          ended_by: state.ended_by,
        };
      }
    } else {
      const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
      return {
        executor_response_tools: [
          ...this.getExecutorResponseTools(state.messages),
          new ToolMessage({
            tool_call_id: createToolCallId(),
            name: 'executor',
            content: lastMessage.tool_calls?.[0]?.args?.reason ?? '',
          }),
        ],
      };
    }
  }

  async askNode(state: typeof StateAnnotation.State) {
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
    const toolCallId = lastMessage.tool_calls?.[0].id ?? createToolCallId();
    const question = lastMessage.tool_calls?.[0]?.args?.question ?? '';

    // Set ask user state and use interrupt
    if (!this.agent.isAskUser) {
      this.agent.setAskUser(true);
      this.agent.notifyAskUser({
        question,
        timestamp: Date.now(),
      });
    }
    const userMessage = interrupt({ question });
    this.agent.setAskUser(false);

    // Log completion with the response data
    this.logToolExecution('ask_user', 'completed', {
      question,
      response: userMessage.input,
    });

    return {
      messages: [
        new ToolMessage({
          content: userMessage.input,
          tool_call_id: toolCallId,
          name: lastMessage.tool_calls?.[0]?.name,
        }),
      ],
    };
  }

  async reviewTransactionNode(state: typeof StateAnnotation.State) {
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;

    if (!lastMessage?.tool_calls) {
      this.logToolExecution('review_transaction', 'completed', {
        status: 'skipped',
        reason: 'No need to review transaction',
      });
      return { messages: [new AIMessage({ content: 'No need to review transaction' })] };
    }

    const toolCalls = lastMessage?.tool_calls;

    for (const toolCall of toolCalls) {
      const tool = this.agent.getRegisteredTools().find(t => t.getName() === toolCall?.name);

      if ((tool as any)?.simulateQuoteTool) {
        let quote;
        try {
          quote = await (tool as any).simulateQuoteTool(toolCall.args);
        } catch (e: any) {
          console.error('Error when simulate quote', e);
          const toolMessage = new ToolMessage({
            name: toolCall.name,
            content: 'Error: ' + e.message,
            tool_call_id: toolCall.id ?? createToolCallId(),
          });
          return new Command({ goto: 'executor_agent', update: { messages: [toolMessage] } });
        }

        // Before human review
        this.logToolExecution('human_review', 'started', {
          question: `I need you to review the transaction and approve it or reject it or 
          if you want to update the transaction, please update the parameters and quote`,
          quote: !!quote,
        });

        if (!this.agent.isAskUser) {
          this.agent.setAskUser(true);
          this.agent.notifyHumanReview({
            toolName: toolCall.name,
            input: toolCall.args,
            data: quote,
            timestamp: Date.now(),
          });
        }

        const humanReview = interrupt<
          { question: string; quote: any },
          { action?: string; input?: string }
        >({
          question: `I need you to review the transaction and approve it or reject it or 
          if you want to update the transaction, please update the parameters and quote`,
          quote: quote,
        });

        if (humanReview.input) {
          this.agent.setAskUser(false);

          //TODO: use model to detect if the human review is approve or reject
          if (!this.model.withStructuredOutput) {
            throw new Error('Model does not support structured output');
          }

          // Define a prompt description to help the model understand the task
          const promptDescription = `
            You are analyzing a human review response for a transaction approval system.
            Your task is to determine if the human wants to:
            1. APPROVE the transaction (proceed with execution)
            2. REJECT the transaction (cancel execution)
            3. UPDATE the transaction (update current transaction with user's modified parameters)
            4. OTHER (other action from user)

            Based solely on the human's response, classify their intent into one of these three categories.
            Next is the human's response:
          `;

          // Create a message with the system prompt
          const systemMessage = new SystemMessage(promptDescription);

          // Then use withStructuredOutput without the problematic description parameter
          const modelWithStructure = this.model.withStructuredOutput(
            z.object({
              action: z.enum(['approve', 'reject', 'update', 'other']),
            }),
          );

          try {
            // Include the system message in the invoke call
            const response = await modelWithStructure.invoke([
              systemMessage,
              new HumanMessage(humanReview.input),
            ]);
            humanReview.action = response.action;
          } catch (e: any) {
            const toolMessage = new ToolMessage({
              name: toolCall.name,
              content: 'Error when classify human review: ' + e.message,
              tool_call_id: toolCall.id ?? createToolCallId(),
            });
            return new Command({ goto: 'executor_agent', update: { messages: [toolMessage] } });
          }
        } else if (!humanReview.action) {
          // If no input and action is not set, default to reject
          humanReview.action = 'reject';
        }

        if (humanReview.action === 'approve') {
          this.logToolExecution('review_transaction', 'completed', {
            status: 'approved',
          });
          return new Command({ goto: 'executor_tools' });
        } else if (humanReview.action === 'reject') {
          this.logToolExecution('review_transaction', 'completed', {
            status: 'rejected',
          });
          const currentPlan = state.plans.find(p => p.plan_id === state.active_plan_id);

          if (currentPlan) {
            currentPlan.status = 'rejected';
            return new Command({
              goto: 'executor_terminate',
              update: {
                plans: [currentPlan],
                reject_transaction: true,
                ended_by: 'reject_transaction',
              },
            });
          } else {
            return new Command({
              goto: 'executor_terminate',
              update: { reject_transaction: true, ended_by: 'reject_transaction' },
            });
          }
        } else if (humanReview.action === 'update') {
          if (!this.model.withStructuredOutput) {
            throw new Error('Model does not support structured output');
          }

          const updateSchema = this.model.withStructuredOutput(
            z.object({
              updates: z.array(
                z.object({
                  parameter: z
                    .string()
                    .describe('The path of the parameter to update in the quote object'),
                  update_to: z.string().describe('The new value to set at this path'),
                }),
              ),
            }),
          );

          const originalArgs = toolCall.args;

          // Invoke with system message first, then the human message
          const response = await updateSchema.invoke([
            new HumanMessage(
              `Update current args based on the following request: ${humanReview.input}
              Extract all the specific parameters user want to change and their new values.
              Current args: ${JSON.stringify(originalArgs, null, 2)}
              `,
            ),
          ]);

          const updatedArgs = JSON.parse(JSON.stringify(originalArgs));
          for (const updateItem of response.updates) {
            set(updatedArgs, updateItem.parameter, updateItem.update_to);
          }

          const toolMessage = new ToolMessage({
            name: toolCall.name,
            content: `Parameters updated: ${JSON.stringify(updatedArgs, null, 2)}`,
            tool_call_id: toolCall.id ?? createToolCallId(),
          });

          this.logToolExecution('review_transaction', 'completed', {
            status: 'updated',
          });
          return new Command({
            goto: 'executor_agent',
            update: {
              executor_input: `${toolCall.name} with args: ${JSON.stringify(updatedArgs, null, 2)}`,
              messages: [toolMessage],
            },
          });
        } else if (humanReview.action === 'other') {
          const currentPlan = state.plans.find(p => p.plan_id === state.active_plan_id);

          if (currentPlan) {
            currentPlan.status = 'rejected';
            return new Command({
              goto: 'executor_terminate',
              update: {
                plans: [currentPlan],
                reject_transaction: true,
                ended_by: 'other_action',
                interrupted_request: humanReview.input,
              },
            });
          }
          return new Command({
            goto: 'executor_terminate',
            update: {
              reject_transaction: true,
              ended_by: 'other_action',
              interrupted_request: humanReview.input,
            },
          });
        }

        this.logToolExecution('review_transaction', 'completed', {
          status: 'No simulateQuoteTool found',
        });

        return new Command({ goto: 'executor_tools' });
      }
    }
  }

  create() {
    const executorGraph = new StateGraph(StateAnnotation)
      .addNode('executor_agent', this.executorAgentNode.bind(this))
      .addNode('executor_tools', new ToolNode(this.tools))
      .addNode('executor_terminate', this.executorTerminateNode.bind(this))
      .addNode('ask_user', this.askNode.bind(this))
      .addNode('review_transaction', this.reviewTransactionNode.bind(this), {
        ends: ['executor_tools', 'executor_agent'],
      })
      .addNode('end', () => {
        return {};
      })
      .addEdge(START, 'executor_agent')
      .addConditionalEdges('executor_agent', this.routeAfterAgent.bind(this), {
        end: 'end',
        ask_user: 'ask_user',
        review_transaction: 'review_transaction',
        executor_tools: 'executor_tools',
        executor_terminate: 'executor_terminate',
      })
      .addEdge('ask_user', 'executor_agent')
      .addEdge('executor_tools', 'executor_agent')
      .addEdge('executor_terminate', 'end')
      .addEdge('end', END);

    return executorGraph.compile();
  }
}
