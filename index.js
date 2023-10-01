// Importer les libs
const { FreeboxClient } = require("freebox-wrapper");
const fs = require('fs');
require('dotenv').config();
const { Telegraf } = require('telegraf')
var bot = new Telegraf(process.env.BOT_TOKEN)
var id = process.env.TELEGRAM_ID
var ffmpeg = require('ffmpeg');
const { exec } = require("child_process");

// Supabase
var { createClient } = require("@supabase/supabase-js");
var supabase = createClient(process.env.SUPABASE_LINK, process.env.SUPABASE_PUBLIC_KEY)

// Obtenir tout les utilisateurs
var users = []
async function getSupabaseUsers() {
	var { data, error } = await supabase.from("users").select("*")
	if (error) return console.log(error)
	users = data
}
getSupabaseUsers() // TODO: on réeffectuera cette fonction toutes les 4 minutes pour être sûr d'avoir les dernières données à chaque fois
// TODO: dans les while true on va faire un forEach sur users pour envoyer les messages à tout le monde

// TODO: on précisera dans Le README qu'il faut pas leak la SUPABASE_PUBLIC_KEY mm si le nom indique qu'elle est publique, c'est pas vrm le cas
// TODO: on précisera aussi dans le README d'activer les RLS (voir celle déjà définit dans la base de données)

// Liste des réponses d'utilisateur qu'on attend
var waitingForReplies = []

// On initialise le client
const freebox = new FreeboxClient({
	appId: 'fbx.notifier',
	appToken: process.env.FREEBOX_TOKEN,
	apiDomain: process.env.FREEBOX_DOMAIN,
	httpsPort: process.env.FREEBOX_PORT
})

// Liste des noms des Freebox
function getFreeboxName(name) {
	if (name.includes("Freebox Server Mini")) return "Freebox Mini 4K"
	if (name.includes("Freebox Delta")) return "Freebox Delta"
	if (name.includes("Freebox Pop")) return "Freebox Pop"
	if (name.includes("Freebox Révolution") || name.includes("Freebox Revolution")) return "Freebox Révolution"
	if (name.includes("Freebox One")) return "Freebox One"
	if (name.includes("Freebox Server")) return "Freebox Server"
	return "Freebox"
}

// Si ffmpeg n'est pas installé avertir l'utilisateur	
exec("ffmpeg -version", (error) => {
	if (error) {
		console.warn("WARN: ffmpeg n'a pas été détecté dans votre système. Il se peut donc que vous ne puissiez pas écouter vos messages vocaux.")
	}
});

// Fonction principale
async function main() {
	// On s'authentifie
	var response = await freebox.authentificate()

	// Si on a pas pu s'authentifier
	if (!response?.success) return console.log("Impossible de se connecter à la Freebox : ", response.msg || response)

	// Lancer le bot
	bot.launch()
	console.log("Bot démarré !")

	// Les fonctions les plus importantes
	logCalls()
	logVoices()

	// Commande start du bot pour une première connexion en lui expliquant au fur et à mesure
	bot.command('start', (ctx) => {
		ctx.replyWithHTML(`
Bienvenue dans Freebox Call Notifier ! Ce bot vous permet de recevoir une notification lors d'un appel entrant sur votre Freebox.

Pour associer une Freebox à votre compte Telegram, vous devrez utiliser l'assistant de configuration via terminal sur un ordinateur connecté au même réseau que votre Freebox.

1. Assurez-vous d'avoir <a href="https://nodejs.dev/fr/download/">Node.js</a> installé sur votre ordinateur.
2. Ouvrez un terminal ("Invite de commandes" sur Windows 10).
3. Dans ce terminal, entrez la commande suivante : <code>npx freebox-notifier-cli</code>
4. Suivez les instructions affichées dans le terminal.

En cas de problème, vous pouvez contacter <a href="https://t.me/el2zay">el2zay</a>.`
			, { disable_web_page_preview: true, allow_sending_without_reply: true }).catch(err => { })
	})

	// Commande logout
	bot.command('logout', async (ctx) => {
		// Créer un identifiant unique pour les boutons
		var id = Date.now();

		// Demander à l'utilisateur de confirmer
		var replyMarkup = {
			inline_keyboard: [
				[
					{
						text: "Se déconnecter",
						callback_data: `yes-${id}`
					},
					{
						text: "Annuler",
						callback_data: `no-${id}`
					},
				]
			]
		};

		// Afficher un message d'attention avec les boutons.
		ctx.replyWithHTML("⚠️ <b>ATTENTION :</b> Lors de la déconnexion, toutes les données enregistrées sur nos serveurs seront supprimées et vous ne serez plus notifié lors d'un appel entrant.\nSi vous souhaitez vous reconnecter plus tard, vous devrez recommencer le processus d'installation via terminal.\n\n<b>Êtes-vous sûr de vouloir vous déconnecter ?</b>", {
			reply_markup: replyMarkup
		}).catch(err => { })

		// Si on annule
		bot.action(`no-${id}`, async (ctx) => {
			// Répondre et supprimer le message
			ctx.answerCbQuery("Action annulé ! Vous ne serez pas déconnecté.").catch(err => { })
			ctx.deleteMessage().catch(err => { })
		})

		// Si on confirme
		bot.action(`yes-${id}`, async (ctx) => {
			// Supprimer les informations de la base de données
			var { error } = await supabase.from("users").delete().match({ userId: ctx?.update?.callback_query?.from?.id })
			if (error) return ctx.answerCbQuery("Une erreur est survenue lors de la déconnexion : " + error.message).catch(err => { })

			// Répondre et supprimer le message
			ctx.deleteMessage().catch(err => { })
			ctx.reply("Vous avez été déconnecté. Une attente de quelques minutes est nécessaire avant la suppression totale de vos données.").catch(err => { })

			// On se décconecte de la Freebox (on vérifie pas l'erreur)
			await freebox.fetch({
				method: "POST",
				url: "v10/login/logout/",
				parseJson: true
			})
		})
	})

	// Commande voicemail
	bot.command('voicemail', async (ctx) => {
		await sendVoicemail();
	})

	// Commande contact
	bot.command('contact', async (ctx) => {
		// Si on a un argument, on envoie directement le contact
		if (ctx.message.text.split(" ").length > 1) {
			var name = ctx.message.text.split(" ")[1]
			return await getContact(name, ctx)
		}

		// Sinon, on demande à l'utilisateur d'envoyer le nom du contact
		ctx.reply("Veuillez envoyer le nom du contact à chercher.").catch(err => { })

		// On attend la réponse de l'utilisateur
		if (waitingForReplies.find(e => e.userId == ctx.message.from.id)) waitingForReplies = waitingForReplies.filter(e => e.userId != ctx.message.from.id)
		waitingForReplies.push({
			userId: ctx.message.from.id,
			created: Date.now(),
			type: "contact",
			ctx: ctx
		})
	})

	// Commande createcontact
	bot.command('createcontact', (ctx) => {
		// Demander à l'utilisateur d'envoyer un message
		ctx.reply("Veuillez envoyer le nom du contact ainsi que son numéro, séparé par une virgule\nExemple : Jean, 0123456789").catch(err => { })

		// On attend la réponse de l'utilisateur
		if (waitingForReplies.find(e => e.userId == ctx.message.from.id)) waitingForReplies = waitingForReplies.filter(e => e.userId != ctx.message.from.id)
		waitingForReplies.push({
			userId: ctx.message.from.id,
			created: Date.now(),
			type: "createcontact-via-cmd",
			ctx: ctx
		})
	})

	// Commande deletecontact
	bot.command('deletecontact', async (ctx) => {
		// Si après deletecontact il y a un nom, on execute la fonction deleteContact
		if (ctx.message.text.split(" ").length > 1) {
			var name = ctx.message.text.split(" ")[1]
			return await deleteContact(name, ctx)
		}

		// Sinon, on demande à l'utilisateur d'envoyer le nom du contact
		ctx.reply("Veuillez envoyer le nom du contact à supprimer.").catch(err => { })

		// On attend la réponse de l'utilisateur
		if (waitingForReplies.find(e => e.userId == ctx.message.from.id)) waitingForReplies = waitingForReplies.filter(e => e.userId != ctx.message.from.id)
		waitingForReplies.push({
			userId: ctx.message.from.id,
			created: Date.now(),
			type: "deletecontact",
			ctx: ctx
		})
	})

	// Commande mynumber
	bot.command('mynumber', async (ctx) => {
		ctx.reply("Votre numéro de téléphone fixe est le : " + await myNumber()).catch(err => { })
	})

	// Action du bouton "Créer un contact"
	bot.action('createcontact', async (ctx) => {
		// Déterminer le numéro de téléphone
		var message = ctx.callbackQuery.message.text
		var num = message.split("de")[1].split("(")[0].trim()

		// Si le numéro est masqué, ne rien faire
		if (num == "Numéro masqué") return ctx.answerCbQuery("Impossible de créer le contact puisque le numéro est masqué.").catch(err => { })

		// Demander le nom du contact
		ctx.reply(`Veuillez envoyer le nom du contact à ajouter au numéro "${num}"`).catch(err => { })

		// On attend la réponse de l'utilisateur
		if (waitingForReplies.find(e => e.userId == ctx.callbackQuery.from.id)) waitingForReplies = waitingForReplies.filter(e => e.userId != ctx.callbackQuery.from.id)
		waitingForReplies.push({
			userId: ctx.callbackQuery.from.id,
			created: Date.now(),
			type: "createcontact-via-btn",
			ctx: ctx,
			num: num
		})
	})

	bot.action('delete-voicemail', async (ctx) => {
		// Récupérer les messages vocaux
		var response = await freebox.fetch({
			method: "GET",
			url: "v10/call/voicemail/",
			parseJson: true
		});
		count = response?.result?.length || 0

		// Récupérer le dernier
		response.result = response?.result?.sort((a, b) => b.date - a.date)
		response = response?.result?.[0] || null

		// Si on a pas de messages vocaux
		if (!response) return ctx.answerCbQuery("Vous n'avez aucun message vocal.").catch(err => { })

		// Supprimer le message vocal
		var { error } = await freebox.fetch({
			method: "DELETE",
			url: `v10/call/voicemail/${response.id}/`
		})

		// Si on a pas pu supprimer le vocal
		if (error) return ctx.answerCbQuery("Impossible de supprimer le message vocal : " + error.msg || error.message || error).catch(err => { })

		// Répondre en disant qu'il a bien été supprimé
		ctx.answerCbQuery(`Le message vocal a bien été supprimé. Il vous reste ${count - 1} message${count - 1 > 1 ? "s" : ""} vocal${count - 1 > 1 ? "s" : ""}.`).catch(err => { })
	})

	// Action du bouton "Supprimer le contact"
	bot.action('deletecontact', async (ctx) => {
		// Déterminer le nom du contact
		var message = ctx.callbackQuery.message.text

		// Le nom se trouve après "du contact" et se trouve entre guillemet
		var name = message.split("du contact")[1].split('"')[1].trim()

		// Supprimer le contact
		await deleteContact(name, ctx)

		// Supprimer le message
		ctx.deleteMessage().catch(err => { })
	})

	// Détecter l'envoi d'un message
	// Note: Ce code doit rester en dessous des autres commandes.
	bot.on('message', async (ctx) => {
		// Empêcher un message envoyé avant le démarrage du bot d'être traité
		if (ctx?.message?.date && ctx.message.date < Math.floor(Date.now() / 1000) - 10) return console.log("Un message envoyé avant le démarrage du bot a été ignoré.")

		// Texte originale
		var text = ctx?.message?.text || ctx?.callbackQuery?.message?.text
		if (text) text = text.trim()
		if (!text) return

		// Auteur du message
		var author = ctx?.message?.from?.id || ctx?.update?.callback_query?.from?.id || ctx?.callbackQuery?.from?.id

		// Récupérer le message et vérifier que c'est un code
		var parsedText = parseInt(text)
		if (!parsedText || (parsedText && (isNaN(parsedText) || text.length != 6))) { // Si c'est PAS un code
			// On récupère si on doit attendre une réponse de l'utilisateur
			var waitingForReply = waitingForReplies.find(e => e.userId == author)
			if (!waitingForReply) return // Si on attend pas de réponse, on ne fait rien
			if (waitingForReply.created < Date.now() - (1000 * 60 * 10)) waitingForReplies = waitingForReplies.filter(e => e.userId != author) // On laisse max 10 minutes pour répondre

			// On récupère le type de réponse qu'on attend
			var type = waitingForReply.type
			if (type == "createcontact-via-cmd") { // Si on attend une réponse pour créer un contact via la commande
				// On récupère le nom et le numéro
				var name = text.split(",")[0];
				var num = text.split(",")[1];

				// Si il n y a pas de virgule expliquez comment il faut faire.
				if (!name) return ctx.replyWithHTML("Veuillez envoyer le nom du contact ainsi que son numéro, séparé par une virgule\nExemple : <b>Jean</b>, 0123456789").catch(err => { })
				if (!num) return ctx.replyWithHTML("Veuillez envoyer le nom du contact ainsi que son numéro, séparé par une virgule\nExemple : Jean, <b>0123456789</b>").catch(err => { })
				// Enlever les espaces du numéro
				num = num.trim()
				// Si numero ne contient pas que des chiffres
				if (num.match(/[^0-9]/g)) return ctx.reply("Le numéro ne peut contenir que des chiffres.").catch(err => { })

				// On créé le contact
				var created = await createContact(name, num);

				// Si il y a une erreur, informer l'utilisateur
				if (created != true) return ctx.reply(`Une erreur est survenue${created == false ? '...' : ` : ${created}`}`).catch(err => { })
				else ctx.reply("Le contact a bien été créé.").catch(err => { })

				// On supprime l'attente
				waitingForReplies = waitingForReplies.filter(e => e.userId != author)
			}
			else if (type == "createcontact-via-btn") { // Si on attend une réponse pour créer un contact via le bouton
				// On créé le contact
				var created = await createContact(text, waitingForReply.num);

				// Si il y a une erreur, informer l'utilisateur
				if (created != true) return ctx.reply(`Une erreur est survenue${created == false ? '...' : ` : ${created}`}`).catch(err => { })
				else ctx.reply("Le contact a bien été créé.").catch(err => { })

				// On supprime l'attente
				waitingForReplies = waitingForReplies.filter(e => e.userId != author)
			}
			else if (type == "contact") { // Si on attend une réponse pour chercher un contact
				// On récupère le nom
				var name = text;

				// On récupère le contact
				await getContact(name, ctx)

				// On supprime l'attente
				waitingForReplies = waitingForReplies.filter(e => e.userId != author)
			}
			else if (type == "deletecontact") { // Si on attend une réponse pour supprimer un contact
				// On récupère le nom
				var name = text;

				// On supprime le contact
				await deleteContact(name, ctx)

				// On supprime l'attente
				waitingForReplies = waitingForReplies.filter(e => e.userId != author)
			}

		} else { // Si c'est un code valide :
			// Obtenir le code unique dans la base de données
			var { data, error } = await supabase.from("uniquecode").select("*").eq("code", text)
			if (error) return ctx.reply("Une erreur est survenue et nous n'avons pas pu récupérer les informations de ce code dans la base des données. Veuillez signaler ce problème.").catch(err => { })

			// Si on a pas de données
			if (!data?.length) return ctx.reply("Oups, on dirait bien que ce code n'existe pas. Celui-ci a peut-être expiré, ou est mal écrit. Dans le cas où vous hébergez vous-même le service, vérifier que vous avez entré la bonne URL d'API lors de l'utilisation du CLI.").catch(err => { })

			// Si on a un code, on l'associe à l'utilisateur
			var { error } = await supabase.from("uniquecode").delete().match({ code: text })
			if (error) ctx.reply("Nous n'avons pas pu supprimer ce code d'association, il expirera tout de même dans moins d'une heure. Veuillez signaler ce problème.").catch(err => { })

			// Si on a des données, on vérifie qu'elles ne sont pas expirées
			var infos = data?.[0]
			if (infos?.created) {
				var created = new Date(data.created)
				if (created < new Date(Date.now() - (1000 * 60 * 50))) return ctx.reply("Oups, on dirait bien que ce code a expiré. Veuillez en générer un nouveau.").catch(err => { }) // 50 minutes
			}

			// On vérifie que l'utilisateur n'a pas déjà associé une box
			var { data, error } = await supabase.from("users").select("*").eq("userId", ctx.message.from.id)
			if (error) return ctx.reply("Une erreur est survenue et nous n'avons pas pu vérifier si vous avez déjà associé une Freebox à votre compte. Veuillez signaler ce problème.").catch(err => { })
			if (data?.length) return ctx.reply("Vous avez déjà associé une Freebox à votre compte, utiliser /logout pour la supprimer.").catch(err => { })

			// On associe le code à l'utilisateur
			var { error } = await supabase.from("users").insert({
				id: Date.now() + Math.floor(Math.random() * 1000000).toString(),
				userId: ctx.message.from.id,
				chatId: ctx.message.chat.id,
				appId: "fbox.notifier",
				appToken: infos?.content?.appToken,
				apiDomain: infos?.content?.apiDomain,
				httpsPort: infos?.content?.httpsPort,
				boxModel: infos?.content?.boxModel,
				created: new Date()
			})
			if (error) console.log(error)
			if (error) return ctx.reply("Une erreur est survenue et nous n'avons pas pu vous associer à votre Freebox. Veuillez signaler ce problème.").catch(err => { })

			// On informe l'utilisateur que tout s'est bien passé
			ctx.reply(`Votre compte Telegram a bien été associé à votre ${getFreeboxName(infos?.content?.boxModel)} !\n\nVous devrez peut-être attendre jusqu'à 5 minutes avant de pouvoir utiliser les commandes du bot, le temps que la synchronisation s'effectue.`).catch(err => { })
		}
	})
}
main().catch((err) => console.error(err));

async function logVoices() {
	// Obtenir les derniers appels
	var response = await freebox.fetch({
		method: "GET",
		url: "v10/call/voicemail/",
		parseJson: true
	});

	// Récupérer le nombre de messages vocaux, et la durée du dernier
	var length = response?.result?.length || 0
	var messageId = response?.result?.[0]?.id || null
	var duration = null // nécessaire car l'API envoie les vocaux avant qu'ils soient finalisés
	var duration2 = null // on doit vérifier deux fois que la durée a changé pour être sûr que le vocal est finalisé
	var lastVoicemailId = null
	var gotOne = false

	// On récupère le dernier message vocal envoyé depuis la base de données
	var { data, error } = await supabase.from("users").select("lastVoicemailId").eq("userId", id)
	if (data?.[0]?.lastVoicemailId) lastVoicemailId = data[0].lastVoicemailId

	// Boucle infinie qui vérifie si un nouveau message vocal est reçu
	while (true) {
		// Obtenir les derniers appels
		var response = await freebox.fetch({
			method: "GET",
			url: "v10/call/voicemail/",
			parseJson: true
		})
		if (response?.result?.length) response = response.result.sort((a, b) => b.date - a.date)

		// Récupérer la taille du tableau
		var newLength = response?.length || 0

		// Si on a pas de vocs, on continue
		if (!newLength) {
			if (newLength != length) length = newLength // On met à jour la taille
			await new Promise(r => setTimeout(r, 5000)); // on attend 5 secondes
			continue
		}

		// Si on a un NOUVEAU message vocal
		if (newLength > length && messageId != response?.[0]?.id) {
			// On obtient l'ID du dernier message vocal
			messageId = response?.[0]?.id || null
			duration = response?.[0]?.duration || null
			gotOne = true
			length = newLength // On met à jour la taille
			await new Promise(r => setTimeout(r, 11000)); // on attend 11 secondes avant de retenter d'obtenir les vocs
			continue
		}

		// Si on a des vocaux en moins
		else if (newLength < length) {
			length = newLength // On met à jour la taille
			continue // On continue
		}

		// Si on a autant de vocaux
		else if (newLength == length && gotOne) {
			// On obtient la nouvelle durée
			var newDuration = response?.[0]?.duration || null

			// Si la durée a changé deux fois, on déduit que le vocal est finalisé
			if (newDuration == duration2 && lastVoicemailId != messageId) {
				// On envoie le message vocal
				gotOne = false
				duration = newDuration
				lastVoicemailId = messageId
				await sendVoicemail(messageId, response?.[0]?.phone_number || null)

				// On enregistre que le message vocal a été envoyé
				var { error } = await supabase.from("users").update({ lastVoicemailId: messageId }).match({ userId: id })
				if (error) console.log(error)

				// On attend 15 secondes avant de retenter d'obtenir les vocs
				await new Promise(r => setTimeout(r, 15000));
				continue
			}

			// Si la durée a changé qu'une fois, on met à jour la durée
			else if (newDuration == duration && lastVoicemailId != messageId) duration2 = newDuration
			else duration = newDuration
		}

		// On attend 5 secondes avant de retenter d'obtenir les vocs
		await new Promise(r => setTimeout(r, 5000));
	}
}

// Notifier des appels entrants
async function logCalls() {
	// On garde une variable pour plus tard
	var injoinable = false

	// Obtenir les derniers appels
	var response = await freebox.fetch({
		method: "GET",
		url: "v10/call/log/",
		parseJson: true
	});
	if (!response.success) return console.log("Impossible de récupérer les derniers appels : ", response.msg || response)

	// On récupère le dernier appel
	lastID = response?.result?.[0]?.id || null

	// Boucle infinie qui vérifie si un nouvel appel est reçu
	while (true) {
		// Obtenir les derniers appels
		var response = await freebox.fetch({
			method: "GET",
			url: "v10/call/log/",
			parseJson: true
		})

		// Si la box est vrm injoinable
		// TODO: faut tester ça en éteignant vrm sa box, j'ai juste testé de deco mon wifi ptdrr
		if (typeof response?.msg == "object" && JSON.stringify(response) == `{"success":false,"msg":{},"json":{}}`){
			if(!injoinable) bot.telegram.sendMessage(id, "Votre Freebox est injoignable. L'accès à Internet est peut-être coupé.").catch(err => { })
			injoinable = true
			await new Promise(r => setTimeout(r, 10000)); // On continue après 10sec (la box s'est ptet éteinte)
			continue
		} else {
			// Si on était injoinable
			if(injoinable) bot.telegram.sendMessage(id, "Votre Freebox semble de nouveau connecté à Internet !").catch(err => { })
			injoinable = false // on est joinable
		}

		// Si il y a une erreur, informer l'utilisateur
		if (!response.success) {
			console.log("Impossible de récupérer les derniers appels : ", response.msg || response)
			await new Promise(r => setTimeout(r, 10000)); // On continue après 10sec (la box s'est ptet éteinte)
			continue
		}

		// On récupère le dernier appel
		response = response?.result?.[0] || null

		// Si le dernier appel est différent du dernier appel enregistré
		if (lastID != response.id) {
			// On obtient les infos, et on définit l'ID du dernier appel enregistré
			var number = response.number;
			var name = response.name;

			// On met en forme le numéro
			if (name == number && number.length == 10) {
				name = number.replace(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4 $5")
				number = number.replace(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4 $5")
			}
			if (name != number && number.length == 10) {
				number = number.replace(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4 $5")
			}

			// On enregistre l'id de l'appel
			lastID = response.id;

			// On ignore les appels qui ne sont pas entrants
			if (response.type == "outgoing") continue

			// On prépare le bouton pour créer un contact
			var replyMarkup = null;
			if (number == name && number) {
				replyMarkup = {
					inline_keyboard: [
						[{
							text: "Créer un contact",
							callback_data: "createcontact"
						}]
					]
				};
			}

			// On envoie le message
			bot.telegram.sendMessage(id, `Nouvel appel entrant de ${name || "Numéro masqué"}${number != name ? ` \n${number || "Numéro masqué"}` : ''}`, {
				reply_markup: replyMarkup
			});
		}
	}
}

// Créer un contact
async function createContact(name, num) {
	// Créer un contact
	const response = await freebox.fetch({
		method: "POST",
		url: "v10/contact/",
		body: JSON.stringify({
			display_name: name, // Avec son nom uniquement, pour l'instant
		}),
		parseJson: true
	});

	// Récupérer l'ID du contact
	const id = response.result.id;

	// Ajouter le numéro au contact
	const addNumber = await freebox.fetch({
		method: "POST",
		url: "v10/number/",
		body: JSON.stringify({
			contact_id: id,
			number: num, // Lui définir le numéro
		}),
		parseJson: true
	});

	return addNumber?.success || addNumber?.msg || false
}

// Obtenir le numéro de téléphone
async function myNumber() {
	// Requête pour récupérer quelques informations sur le compte
	const response = await freebox.fetch({
		method: "GET",
		url: "v10/call/account/",
		parseJson: true
	})
	return response?.result?.phone_number;
}

// Obtenir un contact
async function getContact(name, ctx) {
	// On récupère les contacts
	var response = await freebox.fetch({
		method: "GET",
		url: "v10/contact/",
		parseJson: true
	});

	// Si on a une erreur
	if (!response.success) return ctx.reply("Impossible de récupérer les contacts : " + response.msg || response).catch(err => { })

	// Si l'entrée de l'utilisateur correspond au firstname ou lastname d'un contact
	var contacts = response?.result || []
	name = name.toLowerCase().trim() // permet de rechercher sans tenir compte de la casse
	var contact = contacts.find(e => e.display_name.toLowerCase().trim() == name || e.first_name.toLowerCase().trim() == name || e.last_name.toLowerCase().trim() == name)

	// Si on a pas de contact
	if (!contact) return ctx.reply("Aucun contact n'a pu être trouvé.").catch(err => { })

	// On récupère les numéros du contact
	var response = await freebox.fetch({
		method: "GET",
		url: `v10/contact/${contact.id}/numbers/`,
		parseJson: true
	});

	// Si on a une erreur
	if (!response.success) return ctx.reply("Impossible de récupérer le numéro du contact : " + response.msg || response).catch(err => { })

	// Si on a pas de numéros
	var numbers = response?.result || []
	if (!numbers.length) return ctx.reply("Le contact existe mais aucun numéro n'a pu être trouvé.").catch(err => { })

	// On envoie le ou les numéros
	var message = `Numéro${numbers.length > 1 ? "s" : ""} du contact "${contact.display_name || contact.first_name + contact.last_name}" :\n`
	numbers.forEach(e => {
		message += `${e.number}\n`
	})

	// Ajouter un bouton pour supprimer le contact
	var replyMarkup = {
		inline_keyboard: [
			[{
				text: "Supprimer le contact",
				callback_data: `deletecontact`
			}]
		]
	}
	// Envoyer le message avec le bouton
	ctx.reply(message, { reply_markup: replyMarkup }).catch(err => { })
}

// Supprimer un contact
async function deleteContact(name, ctx) {
	// On récupère les contacts
	var response = await freebox.fetch({
		method: "GET",
		url: "v10/contact/",
		parseJson: true
	});

	// Si on a une erreur
	if (!response.success) return ctx.reply("Impossible de récupérer les contacts : ", response.msg || response).catch(err => { })

	// Si l'entrée de l'utilisateur correspond au firstname ou lastname d'un contact
	var contacts = response?.result || []
	name = name.toLowerCase().trim() // permet de rechercher sans tenir compte de la casse
	var contact = contacts.find(e => e.display_name.toLowerCase().trim() == name || e.first_name.toLowerCase().trim() == name || e.last_name.toLowerCase().trim() == name)

	// Si on a pas de contact
	if (!contact) return ctx.reply("Aucun contact n'a pu être trouvé.").catch(err => { })

	// On supprime le contact
	var response = await freebox.fetch({
		method: "DELETE",
		url: `v10/contact/${contact.id}/`,
		parseJson: true
	});

	// Si on a une erreur
	if (!response.success) return ctx.reply("Impossible de supprimer le contact : ", response.msg || response).catch(err => { })

	// On informe l'utilisateur que le contact a bien été supprimé
	ctx.reply("Le contact a bien été supprimé.").catch(err => { })
}

// Envoyer le dernier message vocal dans le répondeur
async function sendVoicemail(voiceId, number) {
	// Obtenir les messages vocaux
	if (!voiceId) {
		var response = await freebox.fetch({
			method: "GET",
			url: "v10/call/voicemail/",
			parseJson: true
		});

		// Si on a une erreur
		if (!response.success) return bot.telegram.sendMessage(id, "Impossible de récupérer les derniers appels : ", response.msg || response).catch(err => { })

		// On trie pour avoir le plus récent
		response = response?.result || []
		response = response.sort((a, b) => b.date - a.date)

		// Si on a rien
		if (!response.length) return bot.telegram.sendMessage(id, "Vous n'avez aucun message vocal.").catch(err => { })

		// On récupère le dernier
		voiceId = response?.[0]?.id || null
		number = response?.[0]?.phone_number || null
	}

	// On récupère les contacts
	var response = await freebox.fetch({
		method: "GET",
		url: "v10/contact/",
		parseJson: true
	});

	// On rend le numéro de téléphone plus lisible
	if (!number) number = "Numéro masqué"
	if (number.length && !number.startsWith("0") && !number.startsWith("N")) number = "0" + number
	if (number.length == 10) number = number.replace(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4 $5")

	// On télécharge le message vocal
	var responseAudio = await freebox.fetch({
		method: "GET",
		url: `v10/call/voicemail/${voiceId}/audio_file/`
	})

	// (au cas où y'a une erreur de l'API et donc on peut pas obtenir le buffer)
	try {
		// On récupère le buffer
		responseAudio = await responseAudio.buffer()

		// On prépare les infos pour enregistrer le fichier
		var randomid = Math.floor(Math.random() * 1000000).toString()
		var file = `${randomid}_audio.wav`

		// On écrit les données dans le fichier
		fs.writeFileSync(file, responseAudio)

		// Convertir un fichier .wav en .mp3
		var audio = await new ffmpeg(file);

		// Afficher une information à l'utilisateur
		audio.fnExtractSoundToMP3(`${randomid}_audio.mp3`, async function (error) {
			// Créé un bouton pour supprimer le message vocal
			var replyMarkup = {
				inline_keyboard: [
					[{
						text: "Supprimer le dernier message du répondeur",
						callback_data: `delete-voicemail`
					}]
				]
			}

			// Si on a pas d'erreur, envoie le mp3
			if (!error) {
				// Envoyer le message vocal grâce à bot.telegram
				await bot.telegram.sendAudio(id, { source: `${randomid}_audio.mp3` }, {
					reply_markup: replyMarkup, // Ajouter le bouton au message
					title: "Message vocal",
					performer: number
				}).catch(err => { })

				// Supprimer les fichier généré
				try {
					setTimeout(() => {
						fs.unlinkSync(file)
						fs.unlinkSync(`${randomid}_audio.mp3`)
					}, 2000) // au cas où
				} catch (err) { }
			} else {
				// On envoie le fichier wav d'origine
				await bot.telegram.sendAudio(id, { source: file }, {
					reply_markup: replyMarkup, // Ajouter le bouton au message
					title: "Message vocal",
					performer: number
				}).catch(err => { })

				// Supprimer les fichier généré
				try {
					setTimeout(() => {
						fs.unlinkSync(file)
						fs.unlinkSync(`${randomid}_audio.mp3`)
					}, 2000) // au cas où
				} catch (err) { }
			}
		});
	} catch (err) {
		console.log(err)
		bot.telegram.sendMessage(id, "Impossible de récupérer le message vocal : " + err.msg || err.message || err.code || err).catch(err => { })
	}
}