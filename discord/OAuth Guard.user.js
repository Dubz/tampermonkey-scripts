// ==UserScript==
// @name         Discord - OAuth Guard
// @namespace    http://github.com/Dubz/
// @downloadURL  https://raw.githubusercontent.com/Dubz/tampermonkey-scripts/refs/heads/main/discord/OAuth%20Guard.user.js
// @updateURL    https://raw.githubusercontent.com/Dubz/tampermonkey-scripts/refs/heads/main/discord/OAuth%20Guard.user.js
// @version      2026.1007.2023
// @description  Automatically redirect to block apps from sensitive permissions when using OAuth connected apps
// @author       Dubz (dubzz. <@284859960070766602>)
// @homepage     https://github.com/Dubz/tampermonkey-scripts/discord/OAuth%20Guard.user.js
// @match        https://discord.com/oauth2/authorize*
// @icon         none
// @grant        none
// ==/UserScript==

'use strict';

const protect = [
    "dm_channels.read",
    "email",
    "gdm.join",
    "guilds.join",
];

(function() {
    const URI = new URL(window.location.href);
    // console.log("URI " + typeof(URI) + ": " + URI);
    const scope = URI.searchParams.get('scope');
    // console.log("scope " + typeof(scope) + ": " + scope);
    const scopeObj = scope.split(' ');
    // console.log("scopeObj " + typeof(scopeObj) + ": " + scopeObj);
    const newScopeObj = scopeObj.filter((e) => { return !protect.includes(e); });
    // console.log("new scope " + typeof(newScopeObj) + ": " + newScopeObj);
    const newScope = newScopeObj.join(' ');
    URI.searchParams.set('scope', newScope);
    if(scope != newScope) {
        console.log("Redirecting to: " + URI.toString());
        window.location.href = URI.toString();
    }
    //console.log(parsedURI.search["scope"]);
})();
