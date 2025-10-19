# Tools used
For this I used a bunch of tools to achieve the final result:

0. I used the meta prompter (mostly for testing how it works) for generating a prompt to analyse the current application and generate a PRD for the stopwatch application.
1. I used that prompt on ChatGPT 5 in agent mode to analyse the provided sample web application and get some requirements for the stopwatch application so that I do not miss important details.
2. I used perplexity.ai deep research to get me a guide to play default sounds if possible on the browser, this was used as an example for the prompt and the final application so that the final tool used the sounds I found more interesting.
3. Finally I provided some more details and kept using ChatGPT 5 but this time in auto mode to generate a final prompt that would describe the final application to be built
4. I used ChatGPT 5 in auto mode again to generate the final code for the stopwatch application based on the prompt created in step 3.
5. I tested the application manually and found some issues that I provided as feedback to ChatGPT 5 in auto mode again to fix the issues found.  I did not create a new prompt since it was likely that the new one would have different bugs and the last one fixed most of the most glaring issues.
6. I finally removed a padding by hand to make the size of the box smaller and look better and avoid a lot of rework and context sharing with the model.

The use of the tools and workflow, which is dependent on the particular scenario, is great for understanding an existing app or competitor, getting their features and seeing how ours could differentiate, it also makes it easier to get a really great running app, the app is obviously not perfect but it is a great start and a lot of the issues found were edge cases that would be hard to find without extensive testing.