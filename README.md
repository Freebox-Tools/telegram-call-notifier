# Freebox Call Notifier

## Description

Call Notifier est un bot Telegram vous permettant de recevoir une notification lors d'un appel entrant sur votre Freebox pour savoir si l'appel vaut vraiment le coup ou non.

Call Notifier vous informe avant même que votre téléphone ne sonne ! Il indique le numéro de téléphone de l'appelant, et le nom de votre contact si celui-ci est enregistré dans le répertoire de la Freebox.

<a href="https://t.me/freebox_call_notifier_bot"> <img src="assets/on-telegram.png"> </a>

Si vous souhaitez l'hébergez vous même rendez-vous sur le [Wiki](https://github.com/Freebox-Tools/telegram-call-notifier/wiki)


## Fonctionnalités

- Notification instantanée lors d'un appel entrant.

![Appel entrant](assets/image.png)

- Envoie un message vocal lorsque votre correspondant laisse un message sur votre répondeur.
  
![Vocal](assets/image1.jpg)

- Obtenir une retranscription du message laissé sur votre répondeur. (expérimental.)

![Retranscription](assets/image3.jpg)

- Afficher votre numéro de téléphone fixe.
  
![Numéro de téléphone](assets/image4.png)

- Ajouter un contact dans votre répertoire.
  
![Ajouter un contact](assets/image5.jpg)

- Afficher le numéro de téléphone d'un de vos contacts.
  
![Numéro d'un contact](assets/image6.jpg)

- Supprimer un contact de votre répertoire.
  
![Supprimer un contact](assets/image7.jpg)

_____
- Pouvoir activer le WPS et connecter un appareil sans entrer votre mot de passe.


## À savoir

- La première connexion doit être effectuée via un ordinateur connecté au même réseau que votre Freebox Server.
- Vous pouvez héberger vous même le bot sur un serveur (voir le wiki), mais l'[API de Call Notifier](https://github.com/Freebox-Tools/api-notifier) devra également être configurée sur un serveur.
- Le bot est hébergé sur une Freebox Delta 24h/24, 7j/7 (merci free).
- La transcription des vocaux utilise [OpenAI Whisper](https://github.com/openai/whisper), qui nécessite Python et ffmpeg.
